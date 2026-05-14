from pathlib import Path
from unittest.mock import MagicMock, patch

from statigent.benchmarks.mlebench import MLEBenchAdapter


class TestMLEBenchAdapter:
    def test_name(self) -> None:
        adapter = MLEBenchAdapter()
        assert adapter.name == "mlebench"

    @patch("statigent.benchmarks.mlebench._get_registry")
    def test_prepare_downloads_datasets(
        self, mock_get_registry: MagicMock, tmp_path: Path
    ) -> None:
        mock_registry = MagicMock()
        mock_get_registry.return_value = mock_registry
        mock_registry.get_lite_competition_ids.return_value = ["comp-a"]
        mock_competition = MagicMock()
        mock_registry.get_competition.return_value = mock_competition

        with patch(
            "mlebench.data.download_and_prepare_dataset"
        ) as mock_dl:
            adapter = MLEBenchAdapter(data_dir=tmp_path, lite=True)
            adapter.prepare()
            mock_dl.assert_called_once_with(mock_competition)

    def test_evaluate_without_predictions(self, tmp_path: Path) -> None:
        adapter = MLEBenchAdapter(data_dir=tmp_path)
        result = adapter.evaluate([], agent_name="test", model_name="test-model")
        assert result.benchmark_name == "mlebench"
        assert result.score == 0.0
