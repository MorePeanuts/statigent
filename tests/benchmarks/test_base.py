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
        result = ScoreResult(
            score={"accuracy": 0.85},
            details={"per_task": []},
            total_tasks=3,
            others={"total_competitions": 1},
        )
        assert result.score == {"accuracy": 0.85}
        assert result.details == {"per_task": []}
        assert result.total_tasks == 3
        assert result.others == {"total_competitions": 1}


class TestEvalResult:
    def test_eval_result_creation(self):
        result = EvalResult(
            score={"ABQ": 0.85, "PSAQ": 0.9, "UASQ": 0.8},
            details={"metric": "accuracy"},
            agent_name="react",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
            total_tasks=10,
            others={"total_competitions": 2},
        )
        assert result.score == {"ABQ": 0.85, "PSAQ": 0.9, "UASQ": 0.8}
        assert result.total_tasks == 10
        assert result.others == {"total_competitions": 2}
        assert result.agent_name == "react"
        assert result.model_name == "deepseek-v4-flash"
        assert result.benchmark_name == "dabench"

    def test_eval_result_from_score_result(self):
        sr = ScoreResult(
            score={"ABQ": 0.8, "PSAQ": 0.9, "UASQ": 0.85},
            details={"per_question": []},
            total_tasks=10,
            others={"source": "test"},
        )
        er = EvalResult.from_score_result(
            sr,
            agent_name="my-agent",
            model_name="my-model",
            benchmark_name="dsbench",
        )
        assert er.score == {"ABQ": 0.8, "PSAQ": 0.9, "UASQ": 0.85}
        assert er.details == {"per_question": []}
        assert er.total_tasks == 10
        assert er.others == {"source": "test"}
        assert er.agent_name == "my-agent"
        assert er.benchmark_name == "dsbench"

    def test_eval_result_to_dict(self):
        result = EvalResult(
            score={"TLAcc": 0.75, "CLAcc": 0.5},
            details={"per_question": []},
            agent_name="react",
            model_name="deepseek-v4-flash",
            benchmark_name="dsbench-da",
            total_tasks=4,
            others={"judge_model": "judge"},
        )

        assert result.to_dict() == {
            "score": {"TLAcc": 0.75, "CLAcc": 0.5},
            "total_tasks": 4,
            "others": {"judge_model": "judge"},
            "details": {"per_question": []},
            "agent_name": "react",
            "model_name": "deepseek-v4-flash",
            "benchmark_name": "dsbench-da",
        }


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
                    score={"score": 0.0},
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
