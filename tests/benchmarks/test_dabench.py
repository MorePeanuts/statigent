import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from statigent.benchmarks.dabench import DABenchAdapter


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
        assert result.score == 1.0
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
        assert result.details["abq"] == 0.5
