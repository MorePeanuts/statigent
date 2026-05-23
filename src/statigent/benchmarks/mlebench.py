import shutil
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from loguru import logger

from statigent.benchmarks.base import (
    AgentTrace,
    BenchmarkAdapter,
    BenchmarkRunResult,
    EvalResult,
    ScoreResult,
    _sum_trace_input_tokens,
    _sum_trace_output_tokens,
)

if TYPE_CHECKING:
    from mlebench.registry import Competition, Registry

    from statigent.benchmarks.base import DataScienceAgent


def _default_data_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "benchmarks" / "data" / "MLE-Bench"


def _get_registry(data_dir: Path) -> "Registry":
    from mlebench.registry import Registry

    return Registry(data_dir=data_dir)


class MLEBenchAdapter(BenchmarkAdapter):
    """Adapter for the MLE-Bench ML engineering benchmark."""

    name = "mlebench"

    _TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are competing in a Kaggle-style ML competition. "
        "Follow these steps:\n"
        "1. Read the competition description and understand the evaluation metric\n"
        "2. Explore the provided data files\n"
        "3. Build a model to make predictions on the test set\n"
        "4. Save your predictions as a CSV file matching the sample submission format\n"
    )

    def __init__(
        self,
        data_dir: Path | None = None,
        lite: bool = True,
    ) -> None:
        self.data_dir = data_dir or _default_data_dir()
        self.lite = lite
        self._registry: Registry | None = None

    @property
    def registry(self) -> "Registry":
        if self._registry is None:
            self._registry = _get_registry(self.data_dir)
        return self._registry

    def prepare(self) -> None:
        """Verify or download MLE-Bench data."""
        from mlebench.data import download_and_prepare_dataset

        competition_ids = self._get_competition_ids()
        for comp_id in competition_ids:
            competition = self.registry.get_competition(comp_id)
            download_and_prepare_dataset(competition)

        logger.info("MLE-Bench prepared: data_dir={}", self.data_dir)

    def run(self, agent: "DataScienceAgent", **kwargs: Any) -> BenchmarkRunResult:
        """Run agent on MLE-Bench competitions."""
        persister = kwargs.get("persister")
        limit = kwargs.get("limit")
        skip = kwargs.get("skip", 0)

        competition_ids = self._get_competition_ids()
        if skip:
            competition_ids = competition_ids[skip:]
        if limit:
            competition_ids = competition_ids[: int(limit)]

        start_time = time.monotonic()
        input_tokens = 0
        output_tokens = 0
        predictions: list[dict[str, Any]] = []
        traces: dict[str, AgentTrace] = {}
        for comp_id in competition_ids:
            competition = self._get_competition(comp_id)
            if competition is None:
                continue

            work_dir = Path(tempfile.mkdtemp())
            try:
                pred_path, trace = agent.run_modeling_for_eval(
                    competition.description,
                    train_path=competition.public_dir,
                    test_path=competition.public_dir,
                    sample_submission_path=competition.sample_submission,
                    task_instructions=self._TASK_INSTRUCTIONS,
                    work_dir=work_dir,
                )
                pred = {"competition_id": comp_id, "submission_path": str(pred_path)}
                predictions.append(pred)
                traces[comp_id] = trace
                input_tokens += _sum_trace_input_tokens(trace)
                output_tokens += _sum_trace_output_tokens(trace)
                if persister is not None:
                    persister.add_prediction(pred)
                    persister.add_trace(comp_id, trace)
            except Exception:
                shutil.rmtree(work_dir, ignore_errors=True)
                raise
            logger.debug("MLE-Bench {}: submission created", comp_id)

        duration = time.monotonic() - start_time
        if persister is not None:
            persister.set_duration(duration)

        return BenchmarkRunResult(
            predictions=predictions,
            traces=traces,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            duration_seconds=round(duration, 2),
        )

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score MLE-Bench predictions using mlebench grade."""
        from mlebench.grade import grade_csv

        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        if not predictions:
            return EvalResult(
                score={"score": 0.0},
                details={},
                agent_name=agent_name,
                model_name=model_name,
                benchmark_name=self.name,
                total_tasks=0,
            )

        results: list[dict[str, Any]] = []
        for pred in predictions:
            submission_path = Path(pred["submission_path"])
            comp_id = pred["competition_id"]

            if not submission_path.exists():
                results.append(
                    {"competition_id": comp_id, "score": None, "medal": None}
                )
                continue

            try:
                competition = self.registry.get_competition(comp_id)
                report = grade_csv(submission_path, competition)
                results.append(
                    {
                        "competition_id": comp_id,
                        "score": report.score,
                        "any_medal": report.any_medal,
                        "gold_medal": report.gold_medal,
                        "silver_medal": report.silver_medal,
                        "bronze_medal": report.bronze_medal,
                        "above_median": report.above_median,
                    }
                )
            except (ValueError, FileNotFoundError) as exc:
                results.append(
                    {"competition_id": comp_id, "score": None, "error": str(exc)}
                )

        score = (
            sum(1 for r in results if r.get("score") is not None) / len(results)
            if results
            else 0.0
        )
        return EvalResult.from_score_result(
            ScoreResult(
                score={"score": round(score, 4)},
                details={"per_competition": results},
                total_tasks=len(predictions),
            ),
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=self.name,
        )

    def detect_violations(
        self,
        submission_dir: Path,
        output_dir: Path,
        judge_model_name: str = "deepseek-v4-flash",
    ) -> dict[str, Any]:
        """Run rule violation detection using statigent.models."""
        from statigent.models import get_model

        _llm = get_model(judge_model_name)
        logger.warning("detect_violations is a stub — full implementation pending")
        return {"violations_detected": False, "details": {}}

    def _get_competition_ids(self) -> list[str]:
        """Get competition IDs from the lite or full split."""
        if self.lite:
            return cast("list[str]", self.registry.get_lite_competition_ids())
        return cast("list[str]", self.registry.list_competition_ids())

    def _get_competition(self, comp_id: str) -> "Competition | None":
        """Get a Competition object, returning None if data is not prepared."""
        from mlebench.data import is_dataset_prepared

        try:
            competition = self.registry.get_competition(comp_id)
        except (FileNotFoundError, ValueError) as exc:
            logger.warning("MLE-Bench skipping {}: {}", comp_id, exc)
            return None

        if not is_dataset_prepared(competition):
            logger.warning("MLE-Bench skipping {}: data not prepared", comp_id)
            return None

        return competition
