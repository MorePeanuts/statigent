import json
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest
from openai import APIConnectionError

from statigent.benchmarks.base import BenchmarkAdapter, RunPersister
from statigent.benchmarks.dabench import DABenchAdapter
from statigent.errors import StatigentModelError, StatigentParseError


def _write_test_data(tmp_path: Path) -> Path:
    """Write minimal DABench test data and return the data directory."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    tables_dir = data_dir / "da-dev-tables"
    tables_dir.mkdir()

    (tables_dir / "test.csv").write_text("name,age\nAlice,30\nBob,25\n")

    questions = [
        {
            "id": 0,
            "question": "What is the mean age?",
            "concepts": ["Summary Statistics"],
            "constraints": "Round to 2 decimal places",
            "format": "@mean_age[mean_age]",
            "file_name": "test.csv",
            "level": "easy",
        },
        {
            "id": 1,
            "question": "How many rows are there?",
            "concepts": ["Summary Statistics"],
            "constraints": "Integer answer",
            "format": "@row_count[row_count]",
            "file_name": "test.csv",
            "level": "easy",
        },
    ]
    with open(data_dir / "da-dev-questions.jsonl", "w") as f:
        for q in questions:
            f.write(json.dumps(q) + "\n")

    labels = [
        {"id": 0, "common_answers": [["mean_age", "27.5"]]},
        {"id": 1, "common_answers": [["row_count", "2"]]},
    ]
    with open(data_dir / "da-dev-labels.jsonl", "w") as f:
        for label in labels:
            f.write(json.dumps(label) + "\n")

    return data_dir


class TestDABenchAdapter:
    def test_prepare_succeeds_with_valid_data(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

    def test_prepare_fails_with_missing_data(self, tmp_path: Path) -> None:
        adapter = DABenchAdapter(data_dir=tmp_path / "nonexistent")
        with pytest.raises(FileNotFoundError):
            adapter.prepare()

    def test_run_collects_responses(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        mock_agent = MagicMock()
        mock_agent.name = "test-agent"
        mock_agent.model_name = "test-model"
        mock_agent.run_analysis_for_eval.return_value = (
            "@mean_age[27.5]",
            [{"role": "user", "content": "test"}],
        )

        run_result = adapter.run(mock_agent, limit=1)
        assert len(run_result.predictions) == 1
        assert run_result.predictions[0]["id"] == 0
        assert "mean_age" in run_result.predictions[0]["response"]
        assert "0" in run_result.traces

    def test_run_records_task_failure_and_continues(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        mock_agent = MagicMock()
        mock_agent.run_analysis_for_eval.side_effect = [
            StatigentParseError("bad structured output"),
            ("@row_count[2]", [{"role": "assistant", "content": "ok"}]),
        ]

        persister = RunPersister(tmp_path, "agent", "model", "dabench")
        run_result = adapter.run(mock_agent, persister=persister)

        assert len(run_result.predictions) == 2
        assert run_result.predictions[0] == {
            "id": 0,
            "response": "",
            "error": "bad structured output",
        }
        assert run_result.predictions[1]["response"] == "@row_count[2]"
        assert run_result.traces["0"][0]["name"] == "task_error"
        assert persister.prediction_count == 2
        assert len(BenchmarkAdapter.load_predictions(persister.output_dir)) == 2

    def test_run_reraises_api_connection_error(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        mock_agent = MagicMock()
        error = APIConnectionError(request=httpx.Request("POST", "https://api.test"))
        mock_agent.run_analysis_for_eval.side_effect = error

        with pytest.raises(APIConnectionError):
            adapter.run(mock_agent)

    def test_run_reraises_permission_error(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        mock_agent = MagicMock()
        mock_agent.run_analysis_for_eval.side_effect = PermissionError("denied")

        with pytest.raises(PermissionError, match="denied"):
            adapter.run(mock_agent)

    def test_run_reraises_wrapped_infrastructure_error(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        connection_error = APIConnectionError(
            request=httpx.Request("POST", "https://api.test")
        )
        wrapped_error = RuntimeError("wrapped API failure")
        wrapped_error.__cause__ = connection_error
        mock_agent = MagicMock()
        mock_agent.run_analysis_for_eval.side_effect = wrapped_error

        with pytest.raises(RuntimeError, match="wrapped API failure"):
            adapter.run(mock_agent)

    def test_run_records_api_bad_request_and_continues(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        request = httpx.Request("POST", "https://api.test")
        bad_request = httpx.HTTPStatusError(
            "bad request",
            request=request,
            response=httpx.Response(400, request=request),
        )
        mock_agent = MagicMock()
        mock_agent.run_analysis_for_eval.side_effect = [
            bad_request,
            ("@row_count[2]", [{"role": "assistant", "content": "ok"}]),
        ]

        result = adapter.run(mock_agent)

        assert len(result.predictions) == 2
        assert result.predictions[0]["error"] == "bad request"
        assert result.predictions[1]["response"] == "@row_count[2]"

    def test_run_reraises_model_configuration_error(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        mock_agent = MagicMock()
        mock_agent.run_analysis_for_eval.side_effect = StatigentModelError(
            "unknown model"
        )

        with pytest.raises(StatigentModelError, match="unknown model"):
            adapter.run(mock_agent)

    def test_evaluate_scores_correct_predictions(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        predictions = [
            {"id": 0, "response": "@mean_age[27.5]"},
            {"id": 1, "response": "@row_count[2]"},
        ]
        result = adapter.evaluate(
            predictions, agent_name="test", model_name="test-model"
        )
        assert result.score == {"ABQ": 1.0, "PSAQ": 1.0, "UASQ": 1.0}
        assert result.total_tasks == 2
        assert result.others == {}
        assert "total_questions" not in result.details
        assert result.benchmark_name == "dabench"

    def test_evaluate_partial_correct(self, tmp_path: Path) -> None:
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        predictions = [
            {"id": 0, "response": "@mean_age[27.5]"},
            {"id": 1, "response": "@row_count[99]"},
        ]
        result = adapter.evaluate(
            predictions, agent_name="test", model_name="test-model"
        )
        assert result.score["ABQ"] == 0.5
