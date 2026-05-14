import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from statigent.benchmarks.dsbench import DSBenchAdapter


def _write_da_test_data(tmp_path: Path) -> Path:
    """Write minimal DSBench data_analysis test data."""
    base = tmp_path / "DSBench" / "data_analysis"
    data_dir = base / "data"
    data_dir.mkdir(parents=True)

    challenge_dir = data_dir / "00000001"
    challenge_dir.mkdir()
    (challenge_dir / "introduction.txt").write_text("Financial modeling challenge")
    (challenge_dir / "question1.txt").write_text("What is the total revenue?")

    data = [
        {
            "id": "00000001",
            "name": "test-challenge",
            "url": "",
            "txt": "",
            "questions": ["question1"],
            "answers": ["1000000"],
            "year": 2024,
        }
    ]
    with open(base / "data.json", "w") as f:
        for d in data:
            f.write(json.dumps(d) + "\n")

    return base.parent


def _write_dm_test_data(tmp_path: Path) -> Path:
    """Write minimal DSBench data_modeling test data."""
    base = tmp_path / "DSBench" / "data_modeling"
    data_dir = base / "data"
    task_dir = data_dir / "task"
    task_dir.mkdir(parents=True)

    data = [
        {
            "name": "test-competition",
            "url": "https://kaggle.com/test",
            "size": "1kB",
            "year": 2024,
        }
    ]
    with open(base / "data.json", "w") as f:
        for d in data:
            f.write(json.dumps(d) + "\n")

    (task_dir / "test-competition.txt").write_text("Predict the target variable")

    return base.parent


class TestDSBenchAdapterDA:
    def test_prepare_verifies_data_analysis(self, tmp_path: Path) -> None:
        base = _write_da_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_analysis")
        adapter.prepare()

    def test_prepare_fails_with_missing_data(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(
            data_dir=tmp_path / "nonexistent", task="data_analysis"
        )
        with pytest.raises(FileNotFoundError):
            adapter.prepare()

    @patch("statigent.benchmarks.evaluators.get_model")
    def test_evaluate_data_analysis(
        self, mock_get_model: MagicMock, tmp_path: Path
    ) -> None:
        mock_llm = MagicMock()
        mock_response = MagicMock()
        mock_response.content = "True"
        mock_llm.invoke.return_value = mock_response
        mock_get_model.return_value = mock_llm

        base = _write_da_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_analysis")
        adapter.prepare()

        predictions = [{"id": "00000001", "response": "The total revenue is 1000000"}]
        result = adapter.evaluate(
            predictions, agent_name="test", model_name="test-model"
        )
        assert result.benchmark_name == "dsbench-da"
        assert result.score > 0


class TestDSBenchAdapterDM:
    def test_prepare_verifies_data_modeling(self, tmp_path: Path) -> None:
        base = _write_dm_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_modeling")
        adapter.prepare()

    def test_invalid_task_raises(self) -> None:
        with pytest.raises(ValueError, match="task must be"):
            DSBenchAdapter(data_dir=Path("/tmp"), task="invalid")
