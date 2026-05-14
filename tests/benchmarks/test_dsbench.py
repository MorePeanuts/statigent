import io
import json
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from statigent.benchmarks.dsbench import DSBenchAdapter
from statigent.errors import StatigentBenchmarkError


def _write_da_test_data(tmp_path: Path, num_samples: int = 1) -> Path:
    """Write minimal DSBench data_analysis test data."""
    base = tmp_path / "DSBench" / "data_analysis"
    data_dir = base / "data"
    data_dir.mkdir(parents=True)

    data: list[dict] = []
    for i in range(1, num_samples + 1):
        sid = f"{i:08d}"
        challenge_dir = data_dir / sid
        challenge_dir.mkdir()
        (challenge_dir / "introduction.txt").write_text("Financial modeling challenge")
        (challenge_dir / "question1.txt").write_text(
            f"What is the total revenue for {sid}?"
        )
        data.append(
            {
                "id": sid,
                "name": f"test-challenge-{sid}",
                "url": "",
                "txt": "",
                "questions": ["question1"],
                "answers": [f"answer-{sid}"],
                "year": 2024,
            }
        )

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

    @pytest.mark.integration
    def test_prepare_downloads_when_missing(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(
            data_dir=tmp_path / "nonexistent", task="data_analysis"
        )
        adapter.prepare()
        assert len(adapter._samples) > 0

    def test_prepare_downloads_with_mock(self, tmp_path: Path) -> None:
        """Unit test for download+extract using a mocked in-memory zip."""
        adapter = DSBenchAdapter(data_dir=tmp_path / "dsbench", task="data_analysis")

        buf = io.BytesIO()
        sample_json = json.dumps(
            {
                "id": "00000001",
                "name": "test",
                "url": "",
                "txt": "",
                "questions": ["question1"],
                "answers": ["A"],
                "year": 2024,
            }
        )
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("data/00000001/introduction.txt", "Test intro")
            zf.writestr("data/00000001/question1.txt", "Test question")
            zf.writestr("data.json", sample_json + "\n")
        buf.seek(0)
        zip_bytes = buf.read()

        mock_response = MagicMock()
        mock_response.headers = {"content-length": str(len(zip_bytes))}
        mock_response.raise_for_status = MagicMock()
        mock_response.iter_bytes = MagicMock(
            return_value=[
                zip_bytes[i : i + 8192] for i in range(0, len(zip_bytes), 8192)
            ]
        )
        mock_stream = MagicMock()
        mock_stream.__enter__ = MagicMock(return_value=mock_response)
        mock_stream.__exit__ = MagicMock(return_value=False)

        with (
            patch(
                "statigent.benchmarks.dsbench.httpx.stream",
                return_value=mock_stream,
            ),
            patch(
                "statigent.benchmarks.dsbench._DSBENCH_REPO_DIR",
                tmp_path / "repo",
            ),
        ):
            adapter.prepare()
        assert len(adapter._samples) == 1

    def test_prepare_raises_on_download_failure(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(
            data_dir=tmp_path / "nonexistent", task="data_analysis"
        )
        with (
            patch(
                "statigent.benchmarks.dsbench.httpx.stream",
                side_effect=httpx.HTTPError("network error"),
            ),
            pytest.raises(StatigentBenchmarkError, match="Failed to download"),
        ):
            adapter.prepare()

    @patch("statigent.benchmarks.evaluators.get_model")
    def test_evaluate_data_analysis(
        self, mock_get_model: MagicMock, tmp_path: Path
    ) -> None:
        from statigent.benchmarks.evaluators import JudgeVerdict

        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = JudgeVerdict(is_correct=True)
        mock_llm.with_structured_output.return_value = mock_structured
        mock_get_model.return_value = mock_llm

        base = _write_da_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_analysis")
        adapter.prepare()

        predictions = [
            {"id": "00000001/question1", "response": "The total revenue is 1000000"}
        ]
        result = adapter.evaluate(
            predictions, agent_name="test", model_name="test-model"
        )
        assert result.benchmark_name == "dsbench-da"
        assert result.score > 0

    @patch("statigent.benchmarks.evaluators.get_model")
    def test_evaluate_only_judges_predicted_ids(
        self, mock_get_model: MagicMock, tmp_path: Path
    ) -> None:
        """When limit reduces predictions, evaluate must only judge those IDs."""
        from statigent.benchmarks.evaluators import JudgeVerdict

        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = JudgeVerdict(is_correct=True)
        mock_llm.with_structured_output.return_value = mock_structured
        mock_get_model.return_value = mock_llm

        base = _write_da_test_data(tmp_path, num_samples=3)
        adapter = DSBenchAdapter(data_dir=base, task="data_analysis")
        adapter.prepare()
        assert len(adapter._samples) == 3

        # Simulate running with limit=1: only first sample has a prediction
        predictions = [
            {"id": "00000001/question1", "response": "The revenue is 1000000"}
        ]
        result = adapter.evaluate(
            predictions, agent_name="test", model_name="test-model"
        )

        # The judge should only be called once (for the single predicted ID),
        # not 3 times (once per all samples).
        assert mock_structured.invoke.call_count == 1
        assert result.details["total"] == 1


class TestDSBenchAdapterDM:
    def test_prepare_verifies_data_modeling(self, tmp_path: Path) -> None:
        base = _write_dm_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_modeling")
        adapter.prepare()

    def test_invalid_task_raises(self) -> None:
        with pytest.raises(ValueError, match="task must be"):
            DSBenchAdapter(data_dir=Path("/tmp"), task="invalid")
