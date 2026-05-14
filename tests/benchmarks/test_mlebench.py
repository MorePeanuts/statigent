from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from statigent.benchmarks.mlebench import MLEBenchAdapter


class TestMLEBenchAdapter:
    def test_prepare_calls_mlebench_if_needed(self, tmp_path: Path) -> None:
        adapter = MLEBenchAdapter(data_dir=tmp_path, skip_prepare=True)
        adapter.prepare()

    def test_name(self) -> None:
        adapter = MLEBenchAdapter(skip_prepare=True)
        assert adapter.name == "mlebench"

    @patch("statigent.benchmarks.mlebench.subprocess")
    def test_prepare_runs_mlebench_prepare(
        self, mock_subprocess: MagicMock, tmp_path: Path
    ) -> None:
        mock_subprocess.run.return_value = MagicMock(returncode=0)
        adapter = MLEBenchAdapter(data_dir=tmp_path, skip_prepare=False, lite=True)
        assert adapter.lite is True

    def test_evaluate_without_predictions(self, tmp_path: Path) -> None:
        adapter = MLEBenchAdapter(data_dir=tmp_path, skip_prepare=True)
        result = adapter.evaluate([], agent_name="test", model_name="test-model")
        assert result.benchmark_name == "mlebench"
        assert result.score == 0.0
