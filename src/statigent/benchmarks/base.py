import contextlib
import json
import shutil
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol, Self

from loguru import logger

from statigent.errors import StatigentBenchmarkError

AgentTrace = list[dict[str, Any]]
"""Serialized execution trace: each dict is one message with role, content, etc."""


def _sum_trace_input_tokens(trace: AgentTrace) -> int:
    """Sum input_tokens from usage_metadata in a trace."""
    total = 0
    for entry in trace:
        usage = entry.get("usage_metadata")
        if usage:
            total += usage.get("input_tokens", 0)
    return total


def _sum_trace_output_tokens(trace: AgentTrace) -> int:
    """Sum output_tokens from usage_metadata in a trace."""
    total = 0
    for entry in trace:
        usage = entry.get("usage_metadata")
        if usage:
            total += usage.get("output_tokens", 0)
    return total


@dataclass
class BenchmarkRunResult:
    """Result from running an agent on a benchmark."""

    predictions: list[dict[str, Any]]
    traces: dict[str, AgentTrace]
    input_tokens: int = 0
    output_tokens: int = 0
    duration_seconds: float = 0.0


class RunPersister:
    """Writes predictions and traces to disk incrementally as each task completes.

    Created before ``run()`` starts so the output directory and meta.json are
    on disk immediately.  Each adapter calls ``add_prediction()`` and
    ``add_trace()`` after every task.  ``finalize()`` writes scores.json
    after ``evaluate()`` returns.

    Not thread-safe.  Callers must serialize access to the shared
    ``responses.jsonl`` file.
    """

    def __init__(
        self,
        base_dir: Path,
        agent_name: str,
        model_name: str,
        benchmark_name: str,
    ) -> None:
        timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        dir_name = f"{benchmark_name}-{agent_name}-{model_name}-{timestamp}"
        self.output_dir = base_dir / dir_name
        self.output_dir.mkdir(parents=True, exist_ok=True)

        meta: dict[str, Any] = {
            "agent_name": agent_name,
            "model_name": model_name,
            "benchmark_name": benchmark_name,
            "timestamp": timestamp,
        }
        (self.output_dir / "meta.json").write_text(json.dumps(meta, indent=2))

        self._pred_dir = self.output_dir / "predictions"
        self._pred_dir.mkdir(exist_ok=True)
        self._pred_path = self._pred_dir / "responses.jsonl"

        self._trace_dir = self.output_dir / "traces"
        self._eval_dir = self.output_dir / "evaluation"

        self._seen_dests: set[str] = set()
        self._pred_count = 0
        self._input_tokens = 0
        self._output_tokens = 0
        self._duration_seconds = 0.0

    @classmethod
    def open(cls, output_dir: Path) -> "RunPersister":
        """Open an existing output directory for appending.

        Use this when resuming a previously interrupted run so that new
        predictions and traces are appended to the same directory.
        """
        persister = cls.__new__(cls)
        persister.output_dir = output_dir
        persister._pred_dir = output_dir / "predictions"
        persister._pred_path = persister._pred_dir / "responses.jsonl"
        persister._trace_dir = output_dir / "traces"
        persister._eval_dir = output_dir / "evaluation"
        persister._seen_dests = set()
        persister._pred_count = 0
        persister._input_tokens = 0
        persister._output_tokens = 0
        persister._duration_seconds = 0.0
        if persister._pred_path.exists():
            with open(persister._pred_path) as f:
                persister._pred_count = sum(1 for line in f if line.strip())
        meta_path = output_dir / "meta.json"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
            persister._input_tokens = meta.get("input_tokens", 0)
            persister._output_tokens = meta.get(
                "output_tokens", meta.get("total_tokens", 0)
            )
            persister._duration_seconds = meta.get("duration_seconds", 0.0)
        return persister

    def add_prediction(self, prediction: dict[str, Any]) -> None:
        """Persist one prediction immediately.

        Computes destination paths for any associated CSV files, writes the
        JSONL line first, then moves the CSVs.  This ordering ensures that a
        write failure does not leave orphaned CSV files in the output directory.

        **The prediction dict is mutated in-place:** any ``prediction_path``
        or ``submission_path`` key is rewritten to point into the output
        directory.
        """
        moves: list[tuple[Path, Path]] = []
        for path_key in ("prediction_path", "submission_path"):
            src_str = prediction.get(path_key)
            if src_str is None:
                continue
            src = Path(src_str)
            if not src.exists():
                continue
            identifier = (
                prediction.get("name")
                or prediction.get("id")
                or prediction.get("competition_id")
                or "pred"
            )
            identifier = str(identifier).replace("/", "_")
            dest = self._pred_dir / f"{identifier}_{src.name}"
            dest_str = str(dest)
            if dest_str in self._seen_dests:
                suffix = f"_{len(self._seen_dests)}_"
                dest = self._pred_dir / f"{identifier}{suffix}{src.name}"
                dest_str = str(dest)
            self._seen_dests.add(dest_str)
            prediction[path_key] = dest_str
            moves.append((src, dest))

        with open(self._pred_path, "a") as f:
            f.write(json.dumps(prediction) + "\n")
        self._pred_count += 1

        for src, dest in moves:
            shutil.move(src, dest)
            with contextlib.suppress(OSError):
                src.parent.rmdir()

    def add_trace(self, question_id: str, trace: AgentTrace) -> None:
        """Write one trace file immediately and accumulate token usage."""
        if not self._trace_dir.exists():
            self._trace_dir.mkdir(parents=True, exist_ok=True)
        trace_path = self._trace_dir / f"{question_id}.jsonl"
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        trace_lines = [json.dumps(msg) for msg in trace]
        trace_path.write_text("\n".join(trace_lines) + "\n")

        for entry in trace:
            usage = entry.get("usage_metadata")
            if usage:
                self._input_tokens += usage.get("input_tokens", 0)
                self._output_tokens += usage.get("output_tokens", 0)

    def finalize(self, result: "EvalResult") -> None:
        """Write scores.json and update meta.json with tokens/duration."""
        self._eval_dir.mkdir(parents=True, exist_ok=True)
        (self._eval_dir / "scores.json").write_text(
            json.dumps(result.to_dict(), indent=2)
        )

        meta_path = self.output_dir / "meta.json"
        meta: dict[str, Any] = {}
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
        meta.pop("total_tokens", None)
        meta["input_tokens"] = self._input_tokens
        meta["output_tokens"] = self._output_tokens
        meta["duration_seconds"] = self._duration_seconds
        meta_path.write_text(json.dumps(meta, indent=2))

        if self._pred_count == 0:
            self._pred_path.write_text("")

    def set_duration(self, seconds: float) -> None:
        """Set the total run duration (adds to existing for resume)."""
        self._duration_seconds += seconds

    @property
    def prediction_count(self) -> int:
        return self._pred_count


@dataclass
class ScoreResult:
    """Result returned by an Evaluator (metric scores + details only)."""

    score: dict[str, float]
    details: dict[str, Any]
    total_tasks: int = 0
    others: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvalResult:
    """Full evaluation result with agent/model/benchmark context."""

    score: dict[str, float]
    details: dict[str, Any]
    agent_name: str
    model_name: str
    benchmark_name: str
    total_tasks: int = 0
    others: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_score_result(
        cls,
        score_result: ScoreResult,
        agent_name: str,
        model_name: str,
        benchmark_name: str,
    ) -> Self:
        """Create EvalResult from a ScoreResult plus context."""
        return cls(
            score=score_result.score,
            details=score_result.details,
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=benchmark_name,
            total_tasks=score_result.total_tasks,
            others=score_result.others,
        )

    def to_dict(self) -> dict[str, Any]:
        """Serialize the evaluation result for persistence."""
        return {
            "score": self.score,
            "total_tasks": self.total_tasks,
            "others": self.others,
            "details": self.details,
            "agent_name": self.agent_name,
            "model_name": self.model_name,
            "benchmark_name": self.benchmark_name,
        }


class Evaluator(ABC):
    """Abstract base for evaluation strategies."""

    @abstractmethod
    def evaluate(self, predictions: Any, references: Any) -> ScoreResult: ...


class BenchmarkAdapter(ABC):
    """Abstract base for benchmark adapters."""

    name: str

    @abstractmethod
    def prepare(self) -> None:
        """Download/verify benchmark data."""

    @abstractmethod
    def run(self, agent: "DataScienceAgent", **kwargs: Any) -> BenchmarkRunResult:
        """Run agent on benchmark tasks, return predictions and traces."""

    @abstractmethod
    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score predictions against ground truth."""

    def execute(self, agent: "DataScienceAgent", **kwargs: Any) -> EvalResult:
        """Full pipeline: prepare -> run -> evaluate.

        If output_dir is provided in kwargs, creates a RunPersister before
        ``run()`` so that predictions and traces are written to disk
        incrementally as each task completes.
        """
        self.prepare()

        output_dir_raw = kwargs.pop("output_dir", None)
        persister: RunPersister | None = None
        if output_dir_raw is not None:
            persister = RunPersister(
                base_dir=Path(output_dir_raw),
                agent_name=agent.name,
                model_name=agent.model_name,
                benchmark_name=self.name,
            )
            kwargs["persister"] = persister

        run_result = self.run(agent, **kwargs)

        # Don't leak internal keys into evaluate().
        kwargs.pop("persister", None)

        result = self.evaluate(
            run_result.predictions,
            agent_name=agent.name,
            model_name=agent.model_name,
            **kwargs,
        )

        if persister is not None:
            if persister.prediction_count == 0 and run_result.predictions:
                logger.warning(
                    "RunPersister was provided but no predictions were persisted. "
                    "The adapter may not support incremental persistence."
                )
            persister.finalize(result)

        return result

    @staticmethod
    def load_predictions(output_dir: Path) -> list[dict[str, Any]]:
        """Load predictions from a previous run's output directory.

        Reads the ``predictions/responses.jsonl`` file produced by
        :class:`RunPersister`.  Useful when resuming an interrupted run
        so that old predictions can be combined with newly generated ones
        before calling :meth:`evaluate`.
        """
        pred_path = output_dir / "predictions" / "responses.jsonl"
        if not pred_path.exists():
            return []
        predictions: list[dict[str, Any]] = []
        with open(pred_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    predictions.append(json.loads(line))
        return predictions

    @staticmethod
    def persist(
        result: EvalResult,
        predictions: list[dict[str, Any]],
        traces: dict[str, AgentTrace] | None = None,
        base_dir: Path | None = None,
    ) -> Path:
        """Persist evaluation result, predictions, and traces to disk.

        Creates:
            {base_dir}/{benchmark_name}-{agent_name}-{model_name}-{timestamp}/
            ├── meta.json
            ├── predictions/
            │   └── responses.jsonl
            ├── traces/
            │   ├── {question_id}.jsonl
            │   └── ...
            └── evaluation/
                └── scores.json

        Args:
            result: The evaluation result to persist.
            predictions: The raw agent predictions.
            traces: Optional mapping of question_id -> serialized message trace.
            base_dir: Base directory for output. Defaults to ./evaluations/

        Returns:
            Path to the created output directory.
        """
        if base_dir is None:
            base_dir = Path("evaluations")

        try:
            persister = RunPersister(
                base_dir,
                result.agent_name,
                result.model_name,
                result.benchmark_name,
            )
            for p in predictions:
                persister.add_prediction(p)
            if traces:
                for qid, trace in traces.items():
                    persister.add_trace(qid, trace)
            persister.finalize(result)
        except (OSError, TypeError) as exc:
            raise StatigentBenchmarkError(
                f"Failed to persist evaluation results: {exc}"
            ) from exc

        return persister.output_dir


class DataScienceAgent(Protocol):
    """Protocol that agents must satisfy to be evaluated by benchmarks."""

    name: str
    model_name: str

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        """Run agent on an analysis task, return text response and trace.

        Args:
            prompt: The task prompt from the benchmark adapter.
            files: Optional data files the agent should read.
            task_instructions: Benchmark-specific formatting/constraint instructions
                to prepend to the prompt (e.g., output format requirements).
        """
        ...

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
        work_dir: Path | None = None,
    ) -> tuple[Path, AgentTrace]:
        """Run agent on a modeling task, return path to prediction CSV and trace.

        Args:
            prompt: The task prompt from the benchmark adapter.
            train_path: Path to training data.
            test_path: Path to test data.
            sample_submission_path: Path to sample submission CSV.
            task_instructions: Benchmark-specific formatting/constraint instructions.
            work_dir: Optional working directory where the agent should write
                its output (e.g. submission.csv). When provided, the agent
                writes directly to this directory instead of a temporary
                location, giving the caller control over the file lifecycle.
        """
        ...
