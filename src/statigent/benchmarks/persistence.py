import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from statigent.benchmarks.base import EvalResult


def save_eval_result(
    result: EvalResult,
    predictions: list[dict[str, Any]],
    base_dir: Path | None = None,
) -> Path:
    """Persist evaluation result and predictions to disk.

    Creates:
        {base_dir}/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/
        ├── meta.json
        ├── predictions/
        │   └── responses.jsonl
        └── evaluation/
            └── scores.json

    Args:
        result: The evaluation result to persist.
        predictions: The raw agent predictions.
        base_dir: Base directory for output. Defaults to ./evaluations/

    Returns:
        Path to the created output directory.
    """
    if base_dir is None:
        base_dir = Path("evaluations")

    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: UP017
    parts = [result.agent_name, result.model_name, result.benchmark_name, timestamp]
    dir_name = "-".join(parts)
    output_dir = base_dir / dir_name
    output_dir.mkdir(parents=True, exist_ok=True)

    # meta.json
    meta: dict[str, Any] = {
        "agent_name": result.agent_name,
        "model_name": result.model_name,
        "benchmark_name": result.benchmark_name,
        "timestamp": timestamp,
    }
    (output_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    # predictions/responses.jsonl
    pred_dir = output_dir / "predictions"
    pred_dir.mkdir(exist_ok=True)
    if predictions:
        lines = [json.dumps(p) for p in predictions]
        (pred_dir / "responses.jsonl").write_text("\n".join(lines) + "\n")
    else:
        (pred_dir / "responses.jsonl").write_text("")

    # evaluation/scores.json
    eval_dir = output_dir / "evaluation"
    eval_dir.mkdir(exist_ok=True)
    scores: dict[str, Any] = {
        "score": result.score,
        "details": result.details,
        "agent_name": result.agent_name,
        "model_name": result.model_name,
        "benchmark_name": result.benchmark_name,
    }
    (eval_dir / "scores.json").write_text(json.dumps(scores, indent=2))

    return output_dir
