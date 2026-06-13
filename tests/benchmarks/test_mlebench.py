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

        with patch("mlebench.data.download_and_prepare_dataset") as mock_dl:
            adapter = MLEBenchAdapter(data_dir=tmp_path, lite=True)
            adapter.prepare()
            mock_dl.assert_called_once_with(mock_competition)

    def test_evaluate_without_predictions(self, tmp_path: Path) -> None:
        adapter = MLEBenchAdapter(data_dir=tmp_path)
        result = adapter.evaluate([], agent_name="test", model_name="test-model")
        assert result.benchmark_name == "mlebench"
        assert result.score == {"score": 0.0}

    def test_run_records_task_failure_and_continues(self, tmp_path: Path) -> None:
        adapter = MLEBenchAdapter(data_dir=tmp_path)
        competitions = {
            comp_id: MagicMock(
                description=comp_id,
                public_dir=tmp_path,
                sample_submission=tmp_path / "sample.csv",
            )
            for comp_id in ("failed", "successful")
        }
        agent = MagicMock()
        agent.run_modeling_for_eval.side_effect = [
            RuntimeError("model failed"),
            (tmp_path / "submission.csv", [{"role": "assistant", "content": "ok"}]),
        ]

        with (
            patch.object(
                adapter,
                "_get_competition_ids",
                return_value=list(competitions),
            ),
            patch.object(
                adapter,
                "_get_competition",
                side_effect=lambda comp_id: competitions[comp_id],
            ),
        ):
            result = adapter.run(agent)

        assert len(result.predictions) == 2
        assert result.predictions[0]["error"] == "model failed"
        assert result.predictions[1]["competition_id"] == "successful"
