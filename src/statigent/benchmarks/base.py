from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Self


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
    def run(self, agent: "DataScienceAgent", **kwargs: Any) -> Any:
        """Run agent on benchmark tasks, return raw predictions."""

    @abstractmethod
    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score predictions against ground truth."""

    def execute(self, agent: "DataScienceAgent", **kwargs: Any) -> EvalResult:
        """Full pipeline: prepare -> run -> evaluate."""
        self.prepare()
        predictions = self.run(agent, **kwargs)
        return self.evaluate(
            predictions,
            agent_name=agent.name,
            model_name=agent.model_name,
            **kwargs,
        )


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
    ) -> str:
        """Run agent on an analysis task, return text response.

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
    ) -> Path:
        """Run agent on a modeling task, return path to prediction CSV.

        Args:
            prompt: The task prompt from the benchmark adapter.
            train_path: Path to training data.
            test_path: Path to test data.
            sample_submission_path: Path to sample submission CSV.
            task_instructions: Benchmark-specific formatting/constraint instructions.
        """
        ...
