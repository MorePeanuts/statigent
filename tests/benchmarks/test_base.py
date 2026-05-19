from pathlib import Path
from typing import Any

import pytest

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    DataScienceAgent,
    EvalResult,
    ScoreResult,
)


class TestScoreResult:
    def test_score_result_creation(self):
        result = ScoreResult(score=0.85, details={"metric": "accuracy"})
        assert result.score == 0.85
        assert result.details == {"metric": "accuracy"}


class TestEvalResult:
    def test_eval_result_creation(self):
        result = EvalResult(
            score=0.85,
            details={"metric": "accuracy"},
            agent_name="react",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        assert result.score == 0.85
        assert result.agent_name == "react"
        assert result.model_name == "deepseek-v4-flash"
        assert result.benchmark_name == "dabench"

    def test_eval_result_from_score_result(self):
        sr = ScoreResult(score=0.9, details={"abq": 0.8, "psaq": 0.9})
        er = EvalResult.from_score_result(
            sr,
            agent_name="my-agent",
            model_name="my-model",
            benchmark_name="dsbench",
        )
        assert er.score == 0.9
        assert er.details == {"abq": 0.8, "psaq": 0.9}
        assert er.agent_name == "my-agent"
        assert er.benchmark_name == "dsbench"


class TestBenchmarkAdapterABC:
    def test_cannot_instantiate_abc(self):
        with pytest.raises(TypeError):
            BenchmarkAdapter()  # type: ignore[abstract]

    def test_concrete_subclass_must_implement_methods(self):
        class IncompleteAdapter(BenchmarkAdapter):
            name = "incomplete"

        with pytest.raises(TypeError):
            IncompleteAdapter()  # type: ignore[abstract]

    def test_concrete_subclass_with_all_methods(self):
        class DummyAdapter(BenchmarkAdapter):
            name = "dummy"

            def prepare(self) -> None:
                pass

            def run(self, agent: DataScienceAgent, **kwargs: Any) -> Any:
                return []

            def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
                return EvalResult(
                    score=0.0,
                    details={},
                    agent_name="dummy-agent",
                    model_name="dummy-model",
                    benchmark_name=self.name,
                )

        adapter = DummyAdapter()
        assert adapter.name == "dummy"


class TestDataScienceAgentProtocol:
    def test_protocol_compliant_class(self):
        class MyAgent:
            name = "my-agent"
            model_name = "deepseek-v4-flash"

            def run_analysis_for_eval(
                self,
                prompt: str,
                *,
                files: list[Path] | None = None,
                task_instructions: str = "",
            ) -> str:
                return "answer"

            def run_modeling_for_eval(
                self,
                prompt: str,
                *,
                train_path: Path,
                test_path: Path,
                sample_submission_path: Path,
                task_instructions: str = "",
                work_dir: Path | None = None,
            ) -> Path:
                return Path("submission.csv")

        agent: DataScienceAgent = MyAgent()
        assert agent.name == "my-agent"
        assert agent.run_analysis_for_eval("test") == "answer"
