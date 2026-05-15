import io
import json
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from statigent.benchmarks.base import EvalResult
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


class TestComputeNormalizedScore:
    """DSBench normalized score: max(0, (model - baseline) / (GT - baseline))."""

    def test_higher_is_better(self) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        # GT=1.0, baseline=0.5, model=0.75 → (0.75-0.5)/(1.0-0.5) = 0.5
        assert adapter._compute_normalized_score(0.75, 1.0, 0.5) == 0.5

    def test_model_equals_gt(self) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        assert adapter._compute_normalized_score(1.0, 1.0, 0.5) == 1.0

    def test_model_equals_baseline(self) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        assert adapter._compute_normalized_score(0.5, 1.0, 0.5) == 0.0

    def test_model_worse_than_baseline_clamps_zero(self) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        assert adapter._compute_normalized_score(0.3, 1.0, 0.5) == 0.0

    def test_lower_is_better_metric(self) -> None:
        """When GT < baseline (e.g. RMSE), lower model score is better."""
        adapter = DSBenchAdapter(task="data_modeling")
        # GT=0.1, baseline=1.0, model=0.5 → (0.5-1.0)/(0.1-1.0) = 0.5556
        score = adapter._compute_normalized_score(0.5, 0.1, 1.0)
        assert abs(score - 0.5556) < 0.01

    def test_none_model_score_returns_zero(self) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        assert adapter._compute_normalized_score(None, 1.0, 0.5) == 0.0

    def test_none_gt_returns_zero(self) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        assert adapter._compute_normalized_score(0.7, None, 0.5) == 0.0

    def test_none_baseline_returns_zero(self) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        assert adapter._compute_normalized_score(0.7, 1.0, None) == 0.0


class TestReadRefScore:
    """Reading GT/baseline reference scores from result.txt files."""

    def test_valid_float(self, tmp_path: Path) -> None:
        result_file = tmp_path / "result.txt"
        result_file.write_text("0.8765")
        assert DSBenchAdapter._read_ref_score(result_file) == 0.8765

    def test_integer_value(self, tmp_path: Path) -> None:
        result_file = tmp_path / "result.txt"
        result_file.write_text("1.0")
        assert DSBenchAdapter._read_ref_score(result_file) == 1.0

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        result_file = tmp_path / "nonexistent" / "result.txt"
        assert DSBenchAdapter._read_ref_score(result_file) is None

    def test_nan_returns_none(self, tmp_path: Path) -> None:
        result_file = tmp_path / "result.txt"
        result_file.write_text("nan")
        assert DSBenchAdapter._read_ref_score(result_file) is None

    def test_whitespace_stripped(self, tmp_path: Path) -> None:
        result_file = tmp_path / "result.txt"
        result_file.write_text("  0.5  \n")
        assert DSBenchAdapter._read_ref_score(result_file) == 0.5


class TestRunEvalScript:
    """Running per-competition eval scripts and capturing metric scores."""

    def _write_mock_eval_script(self, path: Path, score: str = "0.785") -> Path:
        """Create a mock eval script that writes a score to result.txt."""
        script = (
            "import os, argparse\n"
            "parser = argparse.ArgumentParser()\n"
            "parser.add_argument('--path', required=True)\n"
            "parser.add_argument('--name', required=True)\n"
            "parser.add_argument('--answer_file', required=True)\n"
            "parser.add_argument('--predict_file', required=True)\n"
            "args = parser.parse_args()\n"
            "os.makedirs(os.path.join(args.path, args.name), exist_ok=True)\n"
            "with open(os.path.join(args.path, args.name, 'result.txt'), 'w') as f:\n"
            f"    f.write('{score}')\n"
        )
        path.write_text(script)
        return path

    def test_successful_eval(self, tmp_path: Path) -> None:
        eval_script = self._write_mock_eval_script(tmp_path / "titanic_eval.py")
        answer_file = tmp_path / "answer.csv"
        answer_file.write_text("col\n1\n")
        pred_file = tmp_path / "pred.csv"
        pred_file.write_text("col\n1\n")

        adapter = DSBenchAdapter(task="data_modeling")
        score = adapter._run_eval_script(eval_script, "titanic", answer_file, pred_file)
        assert score == 0.785

    def test_missing_eval_script(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(task="data_modeling")
        score = adapter._run_eval_script(
            tmp_path / "nonexistent.py",
            "test",
            tmp_path / "answer.csv",
            tmp_path / "pred.csv",
        )
        assert score is None

    def test_eval_script_failure(self, tmp_path: Path) -> None:
        eval_script = tmp_path / "fail_eval.py"
        eval_script.write_text("raise RuntimeError('eval failed')")

        adapter = DSBenchAdapter(task="data_modeling")
        score = adapter._run_eval_script(
            eval_script, "fail", tmp_path / "answer.csv", tmp_path / "pred.csv"
        )
        assert score is None

    def test_eval_script_nan_result(self, tmp_path: Path) -> None:
        eval_script = self._write_mock_eval_script(
            tmp_path / "nan_eval.py", score="nan"
        )

        adapter = DSBenchAdapter(task="data_modeling")
        score = adapter._run_eval_script(
            eval_script, "nan_test", tmp_path / "answer.csv", tmp_path / "pred.csv"
        )
        assert score is None


class TestEvaluateDataModeling:
    """Full data_modeling evaluation pipeline."""

    def _setup_ref_scores(
        self, base: Path, name: str, gt: float, baseline: float
    ) -> None:
        gt_dir = base / "data_modeling" / "save_performance" / "GT" / name
        gt_dir.mkdir(parents=True)
        (gt_dir / "result.txt").write_text(str(gt))

        bl_dir = base / "data_modeling" / "save_performance" / "baseline" / name
        bl_dir.mkdir(parents=True)
        (bl_dir / "result.txt").write_text(str(baseline))

    def test_single_competition(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(task="data_modeling", data_dir=tmp_path)
        adapter._samples = [{"name": "titanic"}]

        self._setup_ref_scores(tmp_path, "titanic", gt=1.0, baseline=0.4972)

        pred_path = tmp_path / "titanic.csv"
        pred_path.write_text("col\n1\n")
        predictions = [{"name": "titanic", "prediction_path": str(pred_path)}]

        with patch.object(adapter, "_run_eval_script", return_value=0.785):
            result = adapter._evaluate_data_modeling(
                predictions, agent_name="test_agent", model_name="test_model"
            )

        assert isinstance(result, EvalResult)
        assert result.benchmark_name == "dsbench-dm"
        expected = max(0, (0.785 - 0.4972) / (1.0 - 0.4972))
        assert abs(result.score - round(expected, 4)) < 0.001

    def test_missing_prediction_file(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(task="data_modeling", data_dir=tmp_path)
        adapter._samples = [{"name": "titanic"}]

        self._setup_ref_scores(tmp_path, "titanic", gt=1.0, baseline=0.5)

        predictions = [
            {"name": "titanic", "prediction_path": str(tmp_path / "missing.csv")}
        ]

        result = adapter._evaluate_data_modeling(
            predictions, agent_name="test_agent", model_name="test_model"
        )
        assert result.score == 0.0

    def test_task_completion_rate(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(task="data_modeling", data_dir=tmp_path)
        adapter._samples = [{"name": "comp_a"}, {"name": "comp_b"}]

        self._setup_ref_scores(tmp_path, "comp_a", gt=1.0, baseline=0.5)
        self._setup_ref_scores(tmp_path, "comp_b", gt=1.0, baseline=0.5)

        pred_a = tmp_path / "comp_a.csv"
        pred_a.write_text("col\n1\n")

        predictions = [
            {"name": "comp_a", "prediction_path": str(pred_a)},
            {"name": "comp_b", "prediction_path": str(tmp_path / "missing.csv")},
        ]

        with patch.object(adapter, "_run_eval_script", return_value=0.8):
            result = adapter._evaluate_data_modeling(
                predictions, agent_name="test_agent", model_name="test_model"
            )

        assert result.details["task_completion_rate"] == 0.5

    def test_empty_predictions(self, tmp_path: Path) -> None:
        adapter = DSBenchAdapter(task="data_modeling", data_dir=tmp_path)
        adapter._samples = []

        result = adapter._evaluate_data_modeling(
            [], agent_name="test_agent", model_name="test_model"
        )
        assert result.score == 0.0


class TestPrepareExtractsSavePerformance:
    """prepare() must extract save_performance.zip for data_modeling."""

    def _create_save_performance_zip(self, repo_dir: Path) -> Path:
        """Create a minimal save_performance.zip with GT and baseline entries."""
        zip_path = repo_dir / "data_modeling" / "save_performance.zip"
        zip_path.parent.mkdir(parents=True, exist_ok=True)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("save_performance/GT/titanic/result.txt", "1.0")
            zf.writestr("save_performance/baseline/titanic/result.txt", "0.5")
        buf.seek(0)

        zip_path.write_bytes(buf.read())
        return zip_path

    def test_extracts_save_performance_zip(self, tmp_path: Path) -> None:
        repo_dir = tmp_path / "repo"
        self._create_save_performance_zip(repo_dir)

        data_dir = tmp_path / "data"
        adapter = DSBenchAdapter(task="data_modeling", data_dir=data_dir)

        with patch("statigent.benchmarks.dsbench._DSBENCH_REPO_DIR", repo_dir):
            adapter._extract_save_performance()

        sp_dir = data_dir / "data_modeling" / "save_performance"
        assert sp_dir.exists()
        gt_file = sp_dir / "GT" / "titanic" / "result.txt"
        assert gt_file.exists()
        assert gt_file.read_text() == "1.0"
        bl_file = sp_dir / "baseline" / "titanic" / "result.txt"
        assert bl_file.exists()
        assert bl_file.read_text() == "0.5"

    def test_no_extract_if_already_exists(self, tmp_path: Path) -> None:
        repo_dir = tmp_path / "repo"
        self._create_save_performance_zip(repo_dir)

        data_dir = tmp_path / "data"
        sp_dir = data_dir / "data_modeling" / "save_performance" / "GT"
        sp_dir.mkdir(parents=True)

        adapter = DSBenchAdapter(task="data_modeling", data_dir=data_dir)

        with patch("statigent.benchmarks.dsbench._DSBENCH_REPO_DIR", repo_dir):
            adapter._extract_save_performance()

        # Should not overwrite — zip contains "1.0" but dir already existed
        # Just verify it didn't crash and the dir still exists
        assert sp_dir.exists()
