import json
import shutil
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol, Self

from statigent.errors import StatigentBenchmarkError

AgentTrace = list[dict[str, Any]]
"""Serialized execution trace: each dict is one message with role, content, etc."""


@dataclass
class BenchmarkRunResult:
    """Result from running an agent on a benchmark."""

    predictions: list[dict[str, Any]]
    traces: dict[str, AgentTrace]


@dataclass
class ScoreResult:
    """Result returned by an Evaluator (score + details only)."""

    score: float
    details: dict[str, Any]


@dataclass
class EvalResult:
    """Full evaluation result with agent/model/benchmark context."""

    score: float
    details: dict[str, Any]
    agent_name: str
    model_name: str
    benchmark_name: str

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
        )


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

        If output_dir is provided in kwargs, persists results to disk.
        """
        self.prepare()
        run_result = self.run(agent, **kwargs)
        result = self.evaluate(
            run_result.predictions,
            agent_name=agent.name,
            model_name=agent.model_name,
            **kwargs,
        )

        output_dir = kwargs.get("output_dir")
        if output_dir is not None:
            self.persist(
                result,
                predictions=run_result.predictions,
                traces=run_result.traces,
                base_dir=Path(output_dir),
            )

        return result

    @staticmethod
    def persist(
        result: EvalResult,
        predictions: list[dict[str, Any]],
        traces: dict[str, AgentTrace] | None = None,
        base_dir: Path | None = None,
    ) -> Path:
        """Persist evaluation result, predictions, and traces to disk.

        Creates:
            {base_dir}/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/
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

        timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        parts = [result.agent_name, result.model_name, result.benchmark_name, timestamp]
        dir_name = "-".join(parts)
        output_dir = base_dir / dir_name

        try:
            output_dir.mkdir(parents=True, exist_ok=True)

            # meta.json
            meta: dict[str, Any] = {
                "agent_name": result.agent_name,
                "model_name": result.model_name,
                "benchmark_name": result.benchmark_name,
                "timestamp": timestamp,
            }
            (output_dir / "meta.json").write_text(json.dumps(meta, indent=2))

            # predictions/responses.jsonl
            pred_dir = output_dir / "predictions"
            pred_dir.mkdir(exist_ok=True)

            # Copy prediction CSVs from temp locations into pred_dir so that
            # persisted results are self-contained and re-evaluable.
            persisted: list[dict[str, Any]] = []
            seen_dests: set[str] = set()
            for p in predictions:
                p_copy = dict(p)
                for path_key in ("prediction_path", "submission_path"):
                    src_str = p_copy.get(path_key)
                    if src_str is None:
                        continue
                    src = Path(src_str)
                    if not src.exists():
                        continue
                    identifier = (
                        p_copy.get("name")
                        or p_copy.get("id")
                        or p_copy.get("competition_id")
                        or "pred"
                    )
                    # Sanitize for filesystem safety.
                    identifier = str(identifier).replace("/", "_")
                    dest = pred_dir / f"{identifier}_{src.name}"
                    if str(dest) in seen_dests:
                        dest = pred_dir / f"{identifier}_{len(seen_dests)}_{src.name}"
                    seen_dests.add(str(dest))
                    shutil.copy2(src, dest)
                    p_copy[path_key] = str(dest)
                persisted.append(p_copy)

            if persisted:
                lines = [json.dumps(p) for p in persisted]
                (pred_dir / "responses.jsonl").write_text("\n".join(lines) + "\n")
            else:
                (pred_dir / "responses.jsonl").write_text("")

            # evaluation/scores.json
            eval_dir = output_dir / "evaluation"
            eval_dir.mkdir(exist_ok=True)
            scores: dict[str, Any] = {
                "score": result.score,
                "details": result.details,
                "agent_name": result.agent_name,
                "model_name": result.model_name,
                "benchmark_name": result.benchmark_name,
            }
            (eval_dir / "scores.json").write_text(json.dumps(scores, indent=2))

            # traces/{question_id}.jsonl
            if traces:
                trace_dir = output_dir / "traces"
                trace_dir.mkdir(exist_ok=True)
                for qid, trace in traces.items():
                    trace_path = trace_dir / f"{qid}.jsonl"
                    trace_path.parent.mkdir(parents=True, exist_ok=True)
                    trace_lines = [json.dumps(msg) for msg in trace]
                    trace_path.write_text("\n".join(trace_lines) + "\n")
        except (OSError, TypeError) as exc:
            raise StatigentBenchmarkError(
                f"Failed to persist evaluation results to {output_dir}: {exc}"
            ) from exc

        return output_dir


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
    ) -> tuple[Path, AgentTrace]:
        """Run agent on a modeling task, return path to prediction CSV and trace.

        Args:
            prompt: The task prompt from the benchmark adapter.
            train_path: Path to training data.
            test_path: Path to test data.
            sample_submission_path: Path to sample submission CSV.
            task_instructions: Benchmark-specific formatting/constraint instructions.
        """
        ...
