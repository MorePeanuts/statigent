import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    BenchmarkRunResult,
    DataScienceAgent,
    EvalResult,
)
from statigent.benchmarks.persistence import save_eval_result
from statigent.errors import StatigentBenchmarkError


class TestSaveEvalResult:
    def test_creates_directory_structure(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.85,
            details={"abq": 0.85, "psaq": 0.9},
            agent_name="react-baseline",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        assert output_dir.exists()
        assert (output_dir / "meta.json").exists()
        assert (output_dir / "predictions" / "responses.jsonl").exists()
        assert (output_dir / "evaluation" / "scores.json").exists()

    def test_meta_json_contains_context(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.85,
            details={"abq": 0.85},
            agent_name="react-baseline",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        meta = json.loads((output_dir / "meta.json").read_text())
        assert meta["agent_name"] == "react-baseline"
        assert meta["model_name"] == "deepseek-v4-flash"
        assert meta["benchmark_name"] == "dabench"
        assert "timestamp" in meta

    def test_predictions_saved_as_jsonl(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.5,
            details={},
            agent_name="test-agent",
            model_name="test-model",
            benchmark_name="dabench",
        )
        predictions = [
            {"id": 0, "response": "@count[891]"},
            {"id": 1, "response": "@mean[34.5]"},
        ]
        output_dir = save_eval_result(
            result, predictions=predictions, base_dir=tmp_path
        )
        pred_file = output_dir / "predictions" / "responses.jsonl"
        assert pred_file.exists()
        lines = pred_file.read_text().strip().split("\n")
        assert len(lines) == 2
        assert json.loads(lines[0])["id"] == 0

    def test_scores_json_contains_result(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.75,
            details={"abq": 0.75, "psaq": 0.8},
            agent_name="test-agent",
            model_name="test-model",
            benchmark_name="dsbench-da",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        scores = json.loads(
            (output_dir / "evaluation" / "scores.json").read_text()
        )
        assert scores["score"] == 0.75
        assert scores["details"]["abq"] == 0.75
        assert scores["benchmark_name"] == "dsbench-da"

    def test_directory_name_format(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.0,
            details={},
            agent_name="react-baseline",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        dir_name = output_dir.name
        assert dir_name.startswith("react-baseline-deepseek-v4-flash-dabench-")

    def test_io_error_wrapped_as_benchmark_error(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.0,
            details={},
            agent_name="test",
            model_name="test",
            benchmark_name="test",
        )
        # Make base_dir a file instead of directory to trigger OSError
        (tmp_path / "blocker").write_text("not a dir")
        with pytest.raises(StatigentBenchmarkError, match="Failed to persist"):
            save_eval_result(
                result,
                predictions=[],
                base_dir=tmp_path / "blocker" / "nested",
            )

    def test_traces_saved_as_jsonl(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=1.0,
            details={},
            agent_name="test-agent",
            model_name="test-model",
            benchmark_name="dabench",
        )
        traces = {
            "0": [
                {"role": "user", "content": "What is the mean?"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "name": "python_repl",
                            "args": {"code": "print(42)"},
                            "id": "tc1",
                        }
                    ],
                },
                {
                    "role": "tool",
                    "name": "python_repl",
                    "content": "42",
                    "tool_call_id": "tc1",
                },
                {"role": "assistant", "content": "The mean is 42."},
            ],
            "1": [
                {"role": "user", "content": "How many rows?"},
                {"role": "assistant", "content": "There are 10 rows."},
            ],
        }
        output_dir = save_eval_result(
            result, predictions=[], traces=traces, base_dir=tmp_path
        )
        trace_dir = output_dir / "traces"
        assert trace_dir.exists()

        trace_0 = trace_dir / "0.jsonl"
        assert trace_0.exists()
        lines_0 = trace_0.read_text().strip().split("\n")
        assert len(lines_0) == 4
        assert json.loads(lines_0[0])["role"] == "user"

        trace_1 = trace_dir / "1.jsonl"
        assert trace_1.exists()
        lines_1 = trace_1.read_text().strip().split("\n")
        assert len(lines_1) == 2

    def test_no_traces_dir_when_traces_none(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.5,
            details={},
            agent_name="test",
            model_name="test",
            benchmark_name="test",
        )
        output_dir = save_eval_result(
            result, predictions=[], traces=None, base_dir=tmp_path
        )
        assert not (output_dir / "traces").exists()


class TestExecutePersistence:
    def test_execute_persists_when_output_dir_provided(self, tmp_path: Path) -> None:
        class StubAdapter(BenchmarkAdapter):
            name = "stub"

            def prepare(self) -> None:
                pass

            def run(self, agent: DataScienceAgent, **kwargs: Any) -> BenchmarkRunResult:
                return BenchmarkRunResult(
                    predictions=[{"id": 0, "response": "test"}],
                    traces={"0": [{"role": "user", "content": "test"}]},
                )

            def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
                return EvalResult(
                    score=1.0,
                    details={},
                    agent_name=kwargs["agent_name"],
                    model_name=kwargs["model_name"],
                    benchmark_name=self.name,
                )

        mock_agent = MagicMock()
        mock_agent.name = "test-agent"
        mock_agent.model_name = "test-model"

        adapter = StubAdapter()
        result = adapter.execute(mock_agent, output_dir=str(tmp_path))

        assert result.score == 1.0
        assert (tmp_path / "test-agent-test-model-stub-").parent == tmp_path
        # Find the created directory
        dirs = list(tmp_path.iterdir())
        assert len(dirs) == 1
        assert (dirs[0] / "meta.json").exists()
        assert (dirs[0] / "evaluation" / "scores.json").exists()
        assert (dirs[0] / "traces" / "0.jsonl").exists()

    def test_execute_no_persist_without_output_dir(self, tmp_path: Path) -> None:
        class StubAdapter(BenchmarkAdapter):
            name = "stub"

            def prepare(self) -> None:
                pass

            def run(self, agent: DataScienceAgent, **kwargs: Any) -> BenchmarkRunResult:
                return BenchmarkRunResult(predictions=[], traces={})

            def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
                return EvalResult(
                    score=0.0,
                    details={},
                    agent_name=kwargs["agent_name"],
                    model_name=kwargs["model_name"],
                    benchmark_name=self.name,
                )

        mock_agent = MagicMock()
        mock_agent.name = "test-agent"
        mock_agent.model_name = "test-model"

        adapter = StubAdapter()
        result = adapter.execute(mock_agent)

        assert result.score == 0.0
        # No files should be written to tmp_path
        assert not any(tmp_path.iterdir())
