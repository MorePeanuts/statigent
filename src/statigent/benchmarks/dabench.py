import json
from pathlib import Path
from typing import Any

from loguru import logger

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    DataScienceAgent,
    EvalResult,
)
from statigent.benchmarks.evaluators import ExactMatchEvaluator, ReformatEvaluator

_DABENCH_DATA_DIR = (
    Path(__file__).resolve().parents[4]
    / "benchmarks"
    / "InfiAgent-DABench"
    / "examples"
    / "DA-Agent"
    / "data"
)


class DABenchAdapter(BenchmarkAdapter):
    """Adapter for the DABench closed-form data analysis benchmark."""

    name = "dabench"

    def __init__(
        self,
        data_dir: Path | None = None,
        reformat: bool = False,
        reformat_model: str = "deepseek-v4-flash",
    ) -> None:
        self.data_dir = data_dir or _DABENCH_DATA_DIR
        self.reformat = reformat
        self.reformat_model = reformat_model
        self._questions: list[dict[str, Any]] = []
        self._labels: list[dict[str, Any]] = []

    def prepare(self) -> None:
        """Verify DABench data files exist."""
        questions_path = self.data_dir / "da-dev-questions.jsonl"
        labels_path = self.data_dir / "da-dev-labels.jsonl"
        tables_dir = self.data_dir / "da-dev-tables"

        for p in (questions_path, labels_path):
            if not p.exists():
                raise FileNotFoundError(f"DABench data file not found: {p}")
        if not tables_dir.exists():
            raise FileNotFoundError(f"DABench tables directory not found: {tables_dir}")

        self._questions = _read_jsonl(questions_path)
        self._labels = _read_jsonl(labels_path)
        logger.info(
            "DABench prepared: {} questions, {} labels",
            len(self._questions),
            len(self._labels),
        )

    def run(self, agent: DataScienceAgent, **kwargs: Any) -> list[dict[str, Any]]:
        """Run agent on DABench questions."""
        limit = kwargs.get("limit")
        questions = self._questions[:limit] if limit else self._questions

        predictions: list[dict[str, Any]] = []
        for q in questions:
            csv_path = self.data_dir / "da-dev-tables" / q["file_name"]
            prompt = (
                f"Question: {q['question']}\n\n"
                f"Constraints: {q['constraints']}\n\n"
                f"Output format: {q['format']}\n\n"
                f"Data file: {csv_path}"
            )
            response = agent.run_analysis_for_eval(prompt, files=[csv_path])
            predictions.append({"id": q["id"], "response": response})
            logger.debug("DABench question id={}: response received", q["id"])

        return predictions

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score DABench predictions."""
        agent_name = kwargs.get("agent_name", "unknown")
        model_name = kwargs.get("model_name", "unknown")

        responses = predictions
        if self.reformat:
            reformatter = ReformatEvaluator(model_name=self.reformat_model)
            responses = reformatter.reformat(responses, self._questions)

        evaluator = ExactMatchEvaluator()
        score_result = evaluator.evaluate(responses, self._labels)

        return EvalResult.from_score_result(
            score_result,
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=self.name,
        )


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read a JSONL file and return a list of dicts."""
    items: list[dict[str, Any]] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items
