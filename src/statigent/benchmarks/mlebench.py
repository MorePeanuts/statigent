import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    BenchmarkRunResult,
    EvalResult,
    ScoreResult,
)
from statigent.errors import StatigentBenchmarkError

if TYPE_CHECKING:
    from statigent.benchmarks.base import DataScienceAgent


def _default_data_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "benchmarks" / "data" / "MLE-Bench"


def _default_repo_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "benchmarks" / "MLE-Bench"


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
        repo_dir: Path | None = None,
        lite: bool = True,
        skip_prepare: bool = False,
    ) -> None:
        self.data_dir = data_dir or _default_data_dir()
        self.repo_dir = repo_dir or _default_repo_dir()
        self.lite = lite
        self.skip_prepare = skip_prepare
        self._competition_ids: list[str] = []

    def prepare(self) -> None:
        """Verify or download MLE-Bench data via mlebench prepare."""
        if self.skip_prepare:
            logger.info("MLE-Bench prepare skipped (skip_prepare=True)")
            return

        try:
            result = subprocess.run(
                [
                    "mlebench",
                    "prepare",
                    "--lite" if self.lite else "--all",
                    "--data-dir",
                    str(self.data_dir),
                ],
                capture_output=True,
                text=True,
                cwd=str(self.repo_dir),
            )
            if result.returncode != 0:
                raise StatigentBenchmarkError(
                    f"mlebench prepare failed: {result.stderr}"
                )
        except FileNotFoundError:
            raise StatigentBenchmarkError(
                "mlebench CLI not found. Install with: "
                "pip install -e benchmarks/MLE-Bench/"
            ) from None

        logger.info("MLE-Bench prepared: data_dir={}", self.data_dir)

    def run(self, agent: "DataScienceAgent", **kwargs: Any) -> BenchmarkRunResult:
        """Run agent on MLE-Bench competitions."""
        limit = kwargs.get("limit")

        competition_ids = self._get_competition_ids()
        if limit:
            competition_ids = competition_ids[: int(limit)]

        predictions: list[dict[str, Any]] = []
        traces: dict[str, list[dict[str, Any]]] = {}
        for comp_id in competition_ids:
            comp_dir = self.data_dir / comp_id / "prepared" / "public"
            desc_path = (
                self.repo_dir / "mlebench" / "competitions" / comp_id / "description.md"
            )

            if not comp_dir.exists():
                logger.warning("MLE-Bench skipping {}: data not prepared", comp_id)
                continue

            description = desc_path.read_text() if desc_path.exists() else ""
            sample_sub = comp_dir / "sample_submission.csv"

            pred_path, trace = agent.run_modeling_for_eval(
                description,
                train_path=comp_dir,
                test_path=comp_dir,
                sample_submission_path=sample_sub,
                task_instructions=self._TASK_INSTRUCTIONS,
            )
            predictions.append(
                {"competition_id": comp_id, "submission_path": str(pred_path)}
            )
            traces[comp_id] = trace
            logger.debug("MLE-Bench {}: submission created", comp_id)

        return BenchmarkRunResult(predictions=predictions, traces=traces)

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score MLE-Bench predictions using mlebench grade."""
        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        if not predictions:
            return EvalResult(
                score=0.0,
                details={},
                agent_name=agent_name,
                model_name=model_name,
                benchmark_name=self.name,
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
                result = subprocess.run(
                    [
                        "mlebench",
                        "grade-sample",
                        str(submission_path),
                        comp_id,
                        "--data-dir",
                        str(self.data_dir),
                    ],
                    capture_output=True,
                    text=True,
                    cwd=str(self.repo_dir),
                )
                if result.returncode == 0:
                    results.append(
                        {"competition_id": comp_id, "grade_output": result.stdout}
                    )
                else:
                    results.append(
                        {
                            "competition_id": comp_id,
                            "score": None,
                            "error": result.stderr,
                        }
                    )
            except FileNotFoundError:
                raise StatigentBenchmarkError(
                    "mlebench CLI not found. Install with: "
                    "pip install -e benchmarks/MLE-Bench/"
                ) from None

        score = (
            sum(1 for r in results if r.get("score") is not None) / len(results)
            if results
            else 0.0
        )
        return EvalResult.from_score_result(
            ScoreResult(score=round(score, 4), details={"per_competition": results}),
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

        prompts_path = (
            self.repo_dir / "extras" / "rule_violation_detector" / "prompts.py"
        )
        if not prompts_path.exists():
            raise StatigentBenchmarkError(
                f"Violation prompts not found: {prompts_path}"
            )

        _llm = get_model(judge_model_name)
        logger.warning("detect_violations is a stub — full implementation pending")
        return {"violations_detected": False, "details": {}}

    def _get_competition_ids(self) -> list[str]:
        """Get competition IDs from the lite or full split."""
        split_file = (
            self.repo_dir
            / "experiments"
            / "splits"
            / ("low.txt" if self.lite else "all.txt")
        )
        if split_file.exists():
            return [
                line.strip()
                for line in split_file.read_text().splitlines()
                if line.strip()
            ]

        import sys

        sys.path.insert(0, str(self.repo_dir))
        try:
            from mlebench.registry import Registry  # type: ignore[import-not-found]

            registry = Registry(data_dir=self.data_dir)
            if self.lite:
                return registry.get_lite_competition_ids()  # type: ignore[no-any-return]
            return registry.list_competition_ids()  # type: ignore[no-any-return]
        except ImportError:
            logger.warning("mlebench not importable, returning empty competition list")
            return []
