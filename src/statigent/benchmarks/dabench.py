import json
import time
from pathlib import Path
from typing import Any

from loguru import logger

from statigent.benchmarks.base import (
    AgentTrace,
    BenchmarkAdapter,
    BenchmarkRunResult,
    DataScienceAgent,
    EvalResult,
    _sum_trace_input_tokens,
    _sum_trace_output_tokens,
)
from statigent.benchmarks.evaluators import (
    DABenchExactMatchEvaluator,
    ReformatEvaluator,
)

_DABENCH_DATA_DIR = (
    Path(__file__).resolve().parents[3]
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

    def run(self, agent: DataScienceAgent, **kwargs: Any) -> BenchmarkRunResult:
        """Run agent on DABench questions."""
        persister = kwargs.get("persister")
        limit = kwargs.get("limit")
        task_id = kwargs.get("task_id")
        skip = kwargs.get("skip", 0)

        questions = self._questions
        if task_id:
            questions = [q for q in questions if str(q["id"]) == task_id]
        else:
            if skip:
                questions = questions[skip:]
            if limit:
                questions = questions[:limit]

        if task_id and not questions:
            logger.warning("task_id '{}' did not match any question", task_id)

        start_time = time.monotonic()
        input_tokens = 0
        output_tokens = 0
        predictions: list[dict[str, Any]] = []
        traces: dict[str, AgentTrace] = {}
        for q in questions:
            csv_path = self.data_dir / "da-dev-tables" / q["file_name"]
            prompt = (
                "Answer the following question based on the given dataset.\n"
                f"\n## Question\n{q['question']}\n"
                f"\n## Requirements\n{q['constraints']}\n"
                f"\n## Output Format\n{q['format']}\n"
            )
            response, trace = agent.run_analysis_for_eval(prompt, files=[csv_path])
            qid = str(q["id"])
            pred = {"id": q["id"], "response": response}
            predictions.append(pred)
            traces[qid] = trace
            input_tokens += _sum_trace_input_tokens(trace)
            output_tokens += _sum_trace_output_tokens(trace)
            if persister is not None:
                persister.add_prediction(pred)
                persister.add_trace(qid, trace)
            logger.debug("DABench question id={}: response received", q["id"])

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
        """Score DABench predictions."""
        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        responses = predictions
        if self.reformat:
            reformatter = ReformatEvaluator(model_name=self.reformat_model)
            responses = reformatter.reformat(responses, self._questions)

        evaluator = DABenchExactMatchEvaluator()
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
