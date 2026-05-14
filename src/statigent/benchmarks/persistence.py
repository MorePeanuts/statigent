import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from statigent.benchmarks.base import AgentTrace, EvalResult
from statigent.errors import StatigentBenchmarkError


def save_eval_result(
    result: EvalResult,
    predictions: list[dict[str, Any]],
    traces: dict[str, AgentTrace] | None = None,
    base_dir: Path | None = None,
) -> Path:
    """Persist evaluation result, predictions, and traces to disk.

    Creates:
        {base_dir}/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/
        ├── meta.json
        ├── predictions/
        │   └── responses.jsonl
        ├── traces/
        │   ├── {question_id}.jsonl
        │   └── ...
        └── evaluation/
            └── scores.json

    Args:
        result: The evaluation result to persist.
        predictions: The raw agent predictions.
        traces: Optional mapping of question_id -> serialized message trace.
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

    try:
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

        # traces/{question_id}.jsonl
        if traces:
            trace_dir = output_dir / "traces"
            trace_dir.mkdir(exist_ok=True)
            for qid, trace in traces.items():
                lines = [json.dumps(msg) for msg in trace]
                (trace_dir / f"{qid}.jsonl").write_text("\n".join(lines) + "\n")
    except (OSError, TypeError) as exc:
        raise StatigentBenchmarkError(
            f"Failed to persist evaluation results to {output_dir}: {exc}"
        ) from exc

    return output_dir
