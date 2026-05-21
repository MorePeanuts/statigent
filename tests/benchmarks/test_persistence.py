import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from statigent.benchmarks.base import (
    AgentTrace,
    BenchmarkAdapter,
    BenchmarkRunResult,
    DataScienceAgent,
    EvalResult,
    RunPersister,
)
from statigent.errors import StatigentBenchmarkError


class TestPersist:
    def test_creates_directory_structure(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.85,
            details={"abq": 0.85, "psaq": 0.9},
            agent_name="react",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = BenchmarkAdapter.persist(result, predictions=[], base_dir=tmp_path)
        assert output_dir.exists()
        assert (output_dir / "meta.json").exists()
        assert (output_dir / "predictions" / "responses.jsonl").exists()
        assert (output_dir / "evaluation" / "scores.json").exists()

    def test_meta_json_contains_context(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.85,
            details={"abq": 0.85},
            agent_name="react",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = BenchmarkAdapter.persist(result, predictions=[], base_dir=tmp_path)
        meta = json.loads((output_dir / "meta.json").read_text())
        assert meta["agent_name"] == "react"
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
        output_dir = BenchmarkAdapter.persist(
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
        output_dir = BenchmarkAdapter.persist(result, predictions=[], base_dir=tmp_path)
        scores = json.loads((output_dir / "evaluation" / "scores.json").read_text())
        assert scores["score"] == 0.75
        assert scores["details"]["abq"] == 0.75
        assert scores["benchmark_name"] == "dsbench-da"

    def test_directory_name_format(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.0,
            details={},
            agent_name="react",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = BenchmarkAdapter.persist(result, predictions=[], base_dir=tmp_path)
        dir_name = output_dir.name
        assert dir_name.startswith("dabench-react-deepseek-v4-flash-")

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
            BenchmarkAdapter.persist(
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
        output_dir = BenchmarkAdapter.persist(
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
        output_dir = BenchmarkAdapter.persist(
            result, predictions=[], traces=None, base_dir=tmp_path
        )
        assert not (output_dir / "traces").exists()

    def test_prediction_csv_moved_to_pred_dir(self, tmp_path: Path) -> None:
        csv_src = tmp_path / "raw" / "submission.csv"
        csv_src.parent.mkdir(parents=True)
        csv_src.write_text("PassengerId,Survived\n1,0\n2,1\n")

        result = EvalResult(
            score=0.5,
            details={},
            agent_name="test-agent",
            model_name="test-model",
            benchmark_name="dsbench-dm",
        )
        predictions = [{"name": "titanic", "prediction_path": str(csv_src)}]
        output_dir = BenchmarkAdapter.persist(
            result, predictions=predictions, base_dir=tmp_path / "out"
        )

        # File should be moved into predictions/
        copied = output_dir / "predictions" / "titanic_submission.csv"
        assert copied.exists()
        assert copied.read_text() == "PassengerId,Survived\n1,0\n2,1\n"

        # Source should no longer exist after move
        assert not csv_src.exists()

        # Source parent dir should be cleaned up (empty after move)
        assert not csv_src.parent.exists()

        # responses.jsonl should point to the copied file
        jsonl = output_dir / "predictions" / "responses.jsonl"
        lines = jsonl.read_text().strip().split("\n")
        entry = json.loads(lines[0])
        assert entry["prediction_path"] == str(copied)

    def test_prediction_csv_collision_gets_suffix(self, tmp_path: Path) -> None:
        csv1 = tmp_path / "a" / "submission.csv"
        csv1.parent.mkdir(parents=True)
        csv1.write_text("first")

        csv2 = tmp_path / "b" / "submission.csv"
        csv2.parent.mkdir(parents=True)
        csv2.write_text("second")

        result = EvalResult(
            score=0.5,
            details={},
            agent_name="test-agent",
            model_name="test-model",
            benchmark_name="test",
        )
        # Same name, different source files → second gets a counter suffix
        predictions = [
            {"name": "titanic", "prediction_path": str(csv1)},
            {"name": "titanic", "prediction_path": str(csv2)},
        ]
        output_dir = BenchmarkAdapter.persist(
            result, predictions=predictions, base_dir=tmp_path / "out"
        )

        assert (output_dir / "predictions" / "titanic_submission.csv").exists()
        assert (output_dir / "predictions" / "titanic_1_submission.csv").exists()
        first = output_dir / "predictions" / "titanic_submission.csv"
        second = output_dir / "predictions" / "titanic_1_submission.csv"
        assert first.read_text() == "first"
        assert second.read_text() == "second"

        # Sources moved, not copied
        assert not csv1.exists()
        assert not csv2.exists()
        assert not csv1.parent.exists()
        assert not csv2.parent.exists()

    def test_prediction_path_with_slash_in_id_sanitized(self, tmp_path: Path) -> None:
        csv_src = tmp_path / "raw" / "submission.csv"
        csv_src.parent.mkdir(parents=True)
        csv_src.write_text("data")

        result = EvalResult(
            score=0.5,
            details={},
            agent_name="test",
            model_name="test",
            benchmark_name="test",
        )
        predictions = [{"id": "00000001/question6", "prediction_path": str(csv_src)}]
        output_dir = BenchmarkAdapter.persist(
            result, predictions=predictions, base_dir=tmp_path / "out"
        )

        # The "/" should be replaced with "_"
        copied = output_dir / "predictions" / "00000001_question6_submission.csv"
        assert copied.exists()

    def test_missing_prediction_file_skipped(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.5,
            details={},
            agent_name="test",
            model_name="test",
            benchmark_name="test",
        )
        predictions = [
            {"name": "titanic", "prediction_path": "/nonexistent/submission.csv"},
        ]
        output_dir = BenchmarkAdapter.persist(
            result, predictions=predictions, base_dir=tmp_path / "out"
        )

        # No file copied, path remains unchanged in JSONL
        jsonl = output_dir / "predictions" / "responses.jsonl"
        lines = jsonl.read_text().strip().split("\n")
        entry = json.loads(lines[0])
        assert entry["prediction_path"] == "/nonexistent/submission.csv"


class TestExecutePersistence:
    def test_execute_persists_when_output_dir_provided(self, tmp_path: Path) -> None:
        class StubAdapter(BenchmarkAdapter):
            name = "stub"

            def prepare(self) -> None:
                pass

            def run(self, agent: DataScienceAgent, **kwargs: Any) -> BenchmarkRunResult:
                persister = kwargs.get("persister")
                pred = {"id": 0, "response": "test"}
                trace: dict[str, list[dict[str, Any]]] = {
                    "0": [{"role": "user", "content": "test"}]
                }
                if persister is not None:
                    persister.add_prediction(pred)
                    persister.add_trace("0", trace["0"])
                return BenchmarkRunResult(predictions=[pred], traces=trace)

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
        # Find the created directory
        dirs = list(tmp_path.iterdir())
        assert len(dirs) == 1
        assert dirs[0].name.startswith("stub-test-agent-test-model-")
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

    def test_execute_persists_predictions_incrementally(self, tmp_path: Path) -> None:
        """Verify that execute() writes predictions to disk via the persister."""
        num_tasks = 3

        class InlineAdapter(BenchmarkAdapter):
            name = "inline"

            def prepare(self) -> None:
                pass

            def run(self, agent: DataScienceAgent, **kwargs: Any) -> BenchmarkRunResult:
                persister = kwargs.get("persister")
                predictions: list[dict[str, Any]] = []
                traces: dict[str, AgentTrace] = {}
                for i in range(num_tasks):
                    pred = {"id": i, "response": f"reply-{i}"}
                    trace: AgentTrace = [{"role": "user", "content": str(i)}]
                    predictions.append(pred)
                    traces[str(i)] = trace
                    if persister is not None:
                        persister.add_prediction(pred)
                        persister.add_trace(str(i), trace)
                return BenchmarkRunResult(predictions=predictions, traces=traces)

            def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
                return EvalResult(
                    score=0.5,
                    details={},
                    agent_name=kwargs["agent_name"],
                    model_name=kwargs["model_name"],
                    benchmark_name=self.name,
                )

        mock_agent = MagicMock()
        mock_agent.name = "test-agent"
        mock_agent.model_name = "test-model"

        adapter = InlineAdapter()
        result = adapter.execute(mock_agent, output_dir=str(tmp_path))

        assert result.score == 0.5
        dirs = list(tmp_path.iterdir())
        assert len(dirs) == 1

        # predictions/responses.jsonl should have all 3 lines
        pred_file = dirs[0] / "predictions" / "responses.jsonl"
        assert pred_file.exists()
        lines = pred_file.read_text().strip().split("\n")
        assert len(lines) == num_tasks
        for i, line in enumerate(lines):
            assert json.loads(line)["id"] == i

        # traces should have all 3 files
        for i in range(num_tasks):
            assert (dirs[0] / "traces" / f"{i}.jsonl").exists()

        # scores.json should exist
        assert (dirs[0] / "evaluation" / "scores.json").exists()


class TestRunPersister:
    def test_add_prediction_writes_jsonl_line(self, tmp_path: Path) -> None:
        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        persister.add_prediction({"id": 0, "response": "hello"})
        pred_file = persister.output_dir / "predictions" / "responses.jsonl"
        assert pred_file.exists()
        lines = pred_file.read_text().strip().split("\n")
        assert len(lines) == 1
        assert json.loads(lines[0])["id"] == 0

    def test_add_prediction_moves_csv(self, tmp_path: Path) -> None:
        csv_src = tmp_path / "raw" / "submission.csv"
        csv_src.parent.mkdir(parents=True)
        csv_src.write_text("a,b\n1,2\n")

        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        pred = {"name": "titanic", "prediction_path": str(csv_src)}
        persister.add_prediction(pred)

        copied = persister.output_dir / "predictions" / "titanic_submission.csv"
        assert copied.exists()
        assert copied.read_text() == "a,b\n1,2\n"
        assert not csv_src.exists()
        # The prediction dict was updated in-place
        assert pred["prediction_path"] == str(copied)

    def test_add_trace_writes_file_immediately(self, tmp_path: Path) -> None:
        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        trace: AgentTrace = [{"role": "user", "content": "hello"}]
        persister.add_trace("0", trace)
        trace_file = persister.output_dir / "traces" / "0.jsonl"
        assert trace_file.exists()
        lines = trace_file.read_text().strip().split("\n")
        assert len(lines) == 1
        assert json.loads(lines[0])["role"] == "user"

    def test_multiple_add_prediction_appends_in_order(self, tmp_path: Path) -> None:
        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        persister.add_prediction({"id": 0, "response": "first"})
        persister.add_prediction({"id": 1, "response": "second"})
        persister.add_prediction({"id": 2, "response": "third"})
        pred_file = persister.output_dir / "predictions" / "responses.jsonl"
        lines = pred_file.read_text().strip().split("\n")
        assert len(lines) == 3
        assert json.loads(lines[0])["id"] == 0
        assert json.loads(lines[1])["id"] == 1
        assert json.loads(lines[2])["id"] == 2

    def test_finalize_writes_scores(self, tmp_path: Path) -> None:
        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        persister.add_prediction({"id": 0, "response": "x"})
        persister.finalize(
            EvalResult(
                score=0.95,
                details={"acc": 0.95},
                agent_name="test-agent",
                model_name="test-model",
                benchmark_name="test-bench",
            )
        )
        scores_file = persister.output_dir / "evaluation" / "scores.json"
        assert scores_file.exists()
        scores = json.loads(scores_file.read_text())
        assert scores["score"] == 0.95
        assert scores["details"]["acc"] == 0.95

    def test_no_trace_dir_when_no_traces(self, tmp_path: Path) -> None:
        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        persister.add_prediction({"id": 0, "response": "x"})
        persister.finalize(
            EvalResult(
                score=0.0,
                details={},
                agent_name="test-agent",
                model_name="test-model",
                benchmark_name="test-bench",
            )
        )
        assert not (persister.output_dir / "traces").exists()

    def test_empty_predictions_creates_empty_file(self, tmp_path: Path) -> None:
        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        persister.finalize(
            EvalResult(
                score=0.0,
                details={},
                agent_name="test-agent",
                model_name="test-model",
                benchmark_name="test-bench",
            )
        )
        pred_file = persister.output_dir / "predictions" / "responses.jsonl"
        assert pred_file.exists()
        assert pred_file.read_text() == ""

    def test_crash_recovery(self, tmp_path: Path) -> None:
        """Partial results survive interruption — no finalize() called."""
        persister = RunPersister(tmp_path, "test-agent", "test-model", "test-bench")
        persister.add_prediction({"id": 0, "response": "done"})
        persister.add_trace("0", [{"role": "user", "content": "q"}])
        persister.add_prediction({"id": 1, "response": "done"})
        persister.add_trace("1", [{"role": "user", "content": "q2"}])
        # Simulate crash: third task never runs, finalize never called

        # Verify 2 predictions are on disk
        pred_file = persister.output_dir / "predictions" / "responses.jsonl"
        lines = pred_file.read_text().strip().split("\n")
        assert len(lines) == 2

        # Verify 2 trace files exist
        assert (persister.output_dir / "traces" / "0.jsonl").exists()
        assert (persister.output_dir / "traces" / "1.jsonl").exists()

        # Meta.json exists (created in __init__)
        assert (persister.output_dir / "meta.json").exists()

        # Scores do NOT exist (finalize was never called)
        assert not (persister.output_dir / "evaluation" / "scores.json").exists()
