import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from loguru import logger

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    EvalResult,
)
from statigent.benchmarks.evaluators import LLMJudgeEvaluator
from statigent.errors import StatigentBenchmarkError

if TYPE_CHECKING:
    from statigent.benchmarks.base import DataScienceAgent

_DSBENCH_DATA_DIR = (
    Path(__file__).resolve().parents[3] / "benchmarks" / "data" / "DSBench"
)

TaskType = Literal["data_analysis", "data_modeling"]


class DSBenchAdapter(BenchmarkAdapter):
    """Adapter for the DSBench benchmark (data analysis + data modeling tasks)."""

    name: str

    def __init__(
        self,
        data_dir: Path | None = None,
        task: TaskType = "data_analysis",
        judge_model_name: str = "deepseek-v4-flash",
    ) -> None:
        if task not in ("data_analysis", "data_modeling"):
            raise ValueError(
                f"task must be 'data_analysis' or 'data_modeling', got '{task}'"
            )
        self.task = task
        abbrev = "da" if task == "data_analysis" else "dm"
        self.name = f"dsbench-{abbrev}"
        self.data_dir = data_dir or _DSBENCH_DATA_DIR
        self.judge_model_name = judge_model_name
        self._samples: list[dict[str, Any]] = []

    def prepare(self) -> None:
        """Verify DSBench data files exist."""
        if self.task == "data_analysis":
            data_path = self.data_dir / "data_analysis" / "data.json"
            data_dir = self.data_dir / "data_analysis" / "data"
        else:
            data_path = self.data_dir / "data_modeling" / "data.json"
            data_dir = self.data_dir / "data_modeling" / "data"

        if not data_path.exists():
            raise FileNotFoundError(f"DSBench data file not found: {data_path}")
        if not data_dir.exists():
            raise FileNotFoundError(f"DSBench data directory not found: {data_dir}")

        with open(data_path) as f:
            self._samples = [json.loads(line.strip()) for line in f if line.strip()]
        logger.info("DSBench {} prepared: {} samples", self.task, len(self._samples))

    def run(self, agent: "DataScienceAgent", **kwargs: Any) -> list[dict[str, Any]]:
        """Run agent on DSBench tasks."""
        if self.task == "data_analysis":
            return self._run_data_analysis(agent, **kwargs)
        return self._run_data_modeling(agent, **kwargs)

    _DA_TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are answering a data analysis question about a financial or business "
        "scenario. Provide a clear, concise answer based on the data. "
        "If the question asks for a specific value, state it explicitly.\n"
    )

    def _run_data_analysis(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> list[dict[str, Any]]:
        """Run data analysis task."""
        limit = kwargs.get("limit")
        samples = self._samples[:limit] if limit else self._samples

        predictions: list[dict[str, Any]] = []
        for sample in samples:
            if not sample.get("questions"):
                continue
            sid = sample["id"]
            data_base = self.data_dir / "data_analysis" / "data" / sid

            intro_path = data_base / "introduction.txt"
            introduction = intro_path.read_text() if intro_path.exists() else ""

            for qname in sample["questions"]:
                q_path = data_base / f"{qname}.txt"
                question = q_path.read_text() if q_path.exists() else ""
                prompt = f"{introduction}\n\n{question}"
                response = agent.run_analysis_for_eval(
                    prompt, task_instructions=self._DA_TASK_INSTRUCTIONS
                )
                predictions.append({"id": sid, "response": response})
                logger.debug("DSBench DA id={} q={}: response received", sid, qname)

        return predictions

    _DM_TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are building a predictive model for a data science competition. "
        "Follow these steps:\n"
        "1. Read the training data and understand the features\n"
        "2. Build a model using Python (scikit-learn, xgboost, etc.)\n"
        "3. Generate predictions for the test data\n"
        "4. Save predictions as a CSV file matching the sample submission format\n"
    )

    def _run_data_modeling(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> list[dict[str, Any]]:
        """Run data modeling task."""
        limit = kwargs.get("limit")
        samples = self._samples[:limit] if limit else self._samples

        predictions: list[dict[str, Any]] = []
        for sample in samples:
            name = sample["name"]
            task_path = (
                self.data_dir / "data_modeling" / "data" / "task" / f"{name}.txt"
            )
            description = task_path.read_text() if task_path.exists() else ""

            train_path = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "train.csv"
            )
            test_path = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "test.csv"
            )
            sample_sub = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "sample_submission.csv"
            )

            if not train_path.exists():
                logger.warning("DSBench DM skipping {}: train.csv not found", name)
                continue

            pred_path = agent.run_modeling_for_eval(
                description,
                train_path=train_path,
                test_path=test_path,
                sample_submission_path=sample_sub,
                task_instructions=self._DM_TASK_INSTRUCTIONS,
            )
            predictions.append({"name": name, "prediction_path": str(pred_path)})
            logger.debug("DSBench DM {}: prediction saved", name)

        return predictions

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score DSBench predictions."""
        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        if self.task == "data_analysis":
            return self._evaluate_data_analysis(predictions, agent_name, model_name)
        raise StatigentBenchmarkError(
            "DSBench data_modeling evaluation requires running per-competition "
            "eval scripts — not yet implemented in the adapter layer"
        )

    def _evaluate_data_analysis(
        self,
        predictions: list[dict[str, Any]],
        agent_name: str,
        model_name: str,
    ) -> EvalResult:
        """Evaluate data analysis predictions using LLM judge."""
        refs: list[dict[str, Any]] = []
        for sample in self._samples:
            for qname, answer in zip(
                sample.get("questions", []),
                sample.get("answers", []),
                strict=True,
            ):
                q_path = (
                    self.data_dir
                    / "data_analysis"
                    / "data"
                    / sample["id"]
                    / f"{qname}.txt"
                )
                question = q_path.read_text() if q_path.exists() else ""
                refs.append(
                    {"id": sample["id"], "question": question, "answer": answer}
                )

        evaluator = LLMJudgeEvaluator(judge_model_name=self.judge_model_name)
        score_result = evaluator.evaluate(predictions, refs)
        return EvalResult.from_score_result(
            score_result,
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=self.name,
        )
