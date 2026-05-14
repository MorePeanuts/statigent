import json
import shutil
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import httpx
from loguru import logger

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    BenchmarkRunResult,
    EvalResult,
)
from statigent.benchmarks.evaluators import LLMJudgeEvaluator
from statigent.errors import StatigentBenchmarkError

if TYPE_CHECKING:
    from statigent.benchmarks.base import DataScienceAgent

_DSBENCH_DATA_DIR = (
    Path(__file__).resolve().parents[3] / "benchmarks" / "data" / "DSBench"
)

_DSBENCH_REPO_DIR = (
    Path(__file__).resolve().parents[3] / "benchmarks" / "DSBench"
)

_HF_DATA_URLS: dict[str, str] = {
    "data_analysis": (
        "https://huggingface.co/datasets/liqiang888/DSBench"
        "/resolve/main/data_analysis/data.zip"
    ),
    "data_modeling": (
        "https://huggingface.co/datasets/liqiang888/DSBench"
        "/resolve/main/data_modeling/data.zip"
    ),
}

TaskType = Literal["data_analysis", "data_modeling"]


class DSBenchAdapter(BenchmarkAdapter):
    """Adapter for the DSBench benchmark (data analysis + data modeling tasks)."""

    name: str

    def __init__(
        self,
        data_dir: Path | None = None,
        task: TaskType = "data_analysis",
        judge_model_name: str = "deepseek-v4-flash",
    ) -> None:
        if task not in ("data_analysis", "data_modeling"):
            raise ValueError(
                f"task must be 'data_analysis' or 'data_modeling', got '{task}'"
            )
        self.task = task
        abbrev = "da" if task == "data_analysis" else "dm"
        self.name = f"dsbench-{abbrev}"
        self.data_dir = data_dir or _DSBENCH_DATA_DIR
        self.judge_model_name = judge_model_name
        self._samples: list[dict[str, Any]] = []

    def prepare(self) -> None:
        """Download/verify DSBench data files.

        If the data directory does not exist, downloads the pre-processed
        dataset from HuggingFace and extracts it into ``self.data_dir``.
        """

        task_dir = self.data_dir / self.task
        data_path = task_dir / "data.json"
        data_subdir = task_dir / "data"

        if data_path.exists() and data_subdir.exists():
            self._load_samples(data_path)
            return

        logger.info(
            "DSBench {} data not found at {}, downloading from HuggingFace",
            self.task,
            task_dir,
        )
        self._download_and_extract(task_dir)

        if not data_path.exists() or not data_subdir.exists():
            raise StatigentBenchmarkError(
                f"DSBench data still missing after download: {task_dir}"
            )
        self._load_samples(data_path)

    def _download_and_extract(self, task_dir: Path) -> None:
        """Download the pre-processed zip from HuggingFace and extract it."""
        url = _HF_DATA_URLS[self.task]
        task_dir.mkdir(parents=True, exist_ok=True)

        zip_path = task_dir / "data.zip"
        try:
            with httpx.stream(
                "GET", url, follow_redirects=True, timeout=120.0
            ) as resp:
                resp.raise_for_status()
                total = resp.headers.get("content-length")
                total_mb = f"{int(total) / 1e6:.1f} MB" if total else "unknown size"
                logger.info(
                    "Downloading DSBench {} data ({}) ...", self.task, total_mb
                )
                with open(zip_path, "wb") as f:
                    for chunk in resp.iter_bytes(chunk_size=8192):
                        f.write(chunk)
        except httpx.HTTPError as exc:
            raise StatigentBenchmarkError(
                f"Failed to download DSBench {self.task} data: {exc}"
            ) from exc

        logger.info("Extracting DSBench {} data ...", self.task)
        try:
            with zipfile.ZipFile(zip_path) as zf:
                self._safe_extract(zf, task_dir)
        except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
            raise StatigentBenchmarkError(
                f"Failed to extract DSBench {self.task} data: {exc}"
            ) from exc
        finally:
            zip_path.unlink(missing_ok=True)

        # Copy data.json from the submodule repo if not present after extraction.
        if not (task_dir / "data.json").exists():
            repo_json = _DSBENCH_REPO_DIR / self.task / "data.json"
            if repo_json.exists():
                shutil.copy2(repo_json, task_dir / "data.json")

        logger.info("DSBench {} data ready at {}", self.task, task_dir)

    @staticmethod
    def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
        """Extract zip, validating that no member escapes the target directory."""
        dest_resolved = dest.resolve()
        for member in zf.infolist():
            member_path = (dest / member.filename).resolve()
            if not str(member_path).startswith(str(dest_resolved)):
                raise StatigentBenchmarkError(
                    f"Zip entry '{member.filename}' escapes target directory"
                )
        zf.extractall(dest)

    def _load_samples(self, data_path: Path) -> None:
        with open(data_path) as f:
            self._samples = [json.loads(line.strip()) for line in f if line.strip()]
        logger.info("DSBench {} prepared: {} samples", self.task, len(self._samples))

    def run(self, agent: "DataScienceAgent", **kwargs: Any) -> BenchmarkRunResult:
        """Run agent on DSBench tasks."""
        if self.task == "data_analysis":
            return self._run_data_analysis(agent, **kwargs)
        return self._run_data_modeling(agent, **kwargs)

    _DA_TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are answering a data analysis question about a financial or business "
        "scenario. Provide a clear, concise answer based on the data. "
        "If the question asks for a specific value, state it explicitly.\n"
    )

    def _run_data_analysis(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> BenchmarkRunResult:
        """Run data analysis task."""
        limit = kwargs.get("limit")
        samples = self._samples[:limit] if limit else self._samples

        predictions: list[dict[str, Any]] = []
        traces: dict[str, list[dict[str, Any]]] = {}
        for sample in samples:
            if not sample.get("questions"):
                continue
            sid = sample["id"]
            data_base = self.data_dir / "data_analysis" / "data" / sid

            intro_path = data_base / "introduction.txt"
            introduction = intro_path.read_text() if intro_path.exists() else ""

            data_files = [
                f
                for f in sorted(data_base.iterdir())
                if f.is_file() and f.suffix not in {".txt", ".DS_Store"}
            ]

            for qname in sample["questions"]:
                q_path = data_base / f"{qname}.txt"
                question = q_path.read_text() if q_path.exists() else ""
                prompt = f"{introduction}\n\n{question}"
                response, trace = agent.run_analysis_for_eval(
                    prompt,
                    files=data_files,
                    task_instructions=self._DA_TASK_INSTRUCTIONS,
                )
                qid = f"{sid}/{qname}"
                predictions.append({"id": qid, "response": response})
                traces[qid] = trace
                logger.debug("DSBench DA id={} q={}: response received", sid, qname)

        return BenchmarkRunResult(predictions=predictions, traces=traces)

    _DM_TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are building a predictive model for a data science competition. "
        "Follow these steps:\n"
        "1. Read the training data and understand the features\n"
        "2. Build a model using Python (scikit-learn, xgboost, etc.)\n"
        "3. Generate predictions for the test data\n"
        "4. Save predictions as a CSV file matching the sample submission format\n"
    )

    def _run_data_modeling(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> BenchmarkRunResult:
        """Run data modeling task."""
        limit = kwargs.get("limit")
        samples = self._samples[:limit] if limit else self._samples

        predictions: list[dict[str, Any]] = []
        traces: dict[str, list[dict[str, Any]]] = {}
        for sample in samples:
            name = sample["name"]
            task_path = (
                self.data_dir / "data_modeling" / "data" / "task" / f"{name}.txt"
            )
            description = task_path.read_text() if task_path.exists() else ""

            train_path = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "train.csv"
            )
            test_path = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "test.csv"
            )
            sample_sub = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "sample_submission.csv"
            )

            if not train_path.exists():
                logger.warning("DSBench DM skipping {}: train.csv not found", name)
                continue

            pred_path, trace = agent.run_modeling_for_eval(
                description,
                train_path=train_path,
                test_path=test_path,
                sample_submission_path=sample_sub,
                task_instructions=self._DM_TASK_INSTRUCTIONS,
            )
            predictions.append({"name": name, "prediction_path": str(pred_path)})
            traces[name] = trace
            logger.debug("DSBench DM {}: prediction saved", name)

        return BenchmarkRunResult(predictions=predictions, traces=traces)

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score DSBench predictions."""
        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        if self.task == "data_analysis":
            return self._evaluate_data_analysis(predictions, agent_name, model_name)
        raise StatigentBenchmarkError(
            "DSBench data_modeling evaluation requires running per-competition "
            "eval scripts — not yet implemented in the adapter layer"
        )

    def _evaluate_data_analysis(
        self,
        predictions: list[dict[str, Any]],
        agent_name: str,
        model_name: str,
    ) -> EvalResult:
        """Evaluate data analysis predictions using LLM judge."""
        pred_ids = {p["id"] for p in predictions}
        refs: list[dict[str, Any]] = []
        for sample in self._samples:
            for qname, answer in zip(
                sample.get("questions", []),
                sample.get("answers", []),
                strict=True,
            ):
                qid = f"{sample['id']}/{qname}"
                if qid not in pred_ids:
                    continue
                q_path = (
                    self.data_dir
                    / "data_analysis"
                    / "data"
                    / sample["id"]
                    / f"{qname}.txt"
                )
                question = q_path.read_text() if q_path.exists() else ""
                refs.append(
                    {
                        "id": qid,
                        "question": question,
                        "answer": answer,
                    }
                )

        evaluator = LLMJudgeEvaluator(judge_model_name=self.judge_model_name)
        score_result = evaluator.evaluate(predictions, refs)

        # Compute per-challenge accuracy to align with original DSBench eval logic.
        per_question = score_result.details.get("per_question", [])
        challenge_verdicts: dict[str, list[bool]] = {}
        for detail in per_question:
            sid = detail["id"].split("/")[0]
            challenge_verdicts.setdefault(sid, []).append(detail["verdict"])
        challenge_accuracies = {
            sid: sum(v) / len(v)
            for sid, v in challenge_verdicts.items()
            if v
        }
        avg_challenge_acc = (
            sum(challenge_accuracies.values()) / len(challenge_accuracies)
            if challenge_accuracies
            else 0.0
        )
        score_result.details["challenge_accuracies"] = challenge_accuracies
        score_result.details["avg_challenge_accuracy"] = round(avg_challenge_acc, 4)

        return EvalResult.from_score_result(
            score_result,
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=self.name,
        )
