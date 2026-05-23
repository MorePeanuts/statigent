import json
from pathlib import Path
from typing import Any

from rich.table import Table

from statigent.benchmarks.base import EvalResult

_META_TABLE_KEYS = ("input_tokens", "output_tokens", "duration_seconds")
_SCORE_TABLE_KEYS = ("score", "total_tasks", "others")


def build_evaluation_table(
    run_dir: Path | None,
    *,
    result: EvalResult | None = None,
) -> Table:
    """Build a compact table from persisted evaluation metadata and scores."""
    meta = _load_json(run_dir / "meta.json") if run_dir is not None else {}
    scores = (
        _load_json(run_dir / "evaluation" / "scores.json")
        if run_dir is not None
        else {}
    )
    if not scores and result is not None:
        scores = result.to_dict()

    table = Table(title="Evaluation Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")

    for key in _META_TABLE_KEYS:
        if key in meta:
            table.add_row(key, _format_value(meta[key]))

    for key in _SCORE_TABLE_KEYS:
        if key in scores:
            table.add_row(key, _format_value(scores[key]))

    for key, value in scores.items():
        if key == "details" or key in _SCORE_TABLE_KEYS:
            continue
        table.add_row(key, _format_value(value))

    return table


def find_latest_run_dir(base_dir: Path, result: EvalResult) -> Path | None:
    """Find the newest persisted run directory matching an evaluation result."""
    if not base_dir.exists():
        return None

    matches: list[tuple[str, float, Path]] = []
    for child in base_dir.iterdir():
        if not child.is_dir():
            continue
        meta_path = child / "meta.json"
        if not meta_path.exists():
            continue
        meta = _load_json(meta_path)
        if (
            meta.get("agent_name") != result.agent_name
            or meta.get("model_name") != result.model_name
            or meta.get("benchmark_name") != result.benchmark_name
        ):
            continue
        matches.append((str(meta.get("timestamp", "")), child.stat().st_mtime, child))

    if not matches:
        return None
    return max(matches, key=lambda item: (item[0], item[1]))[2]


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    if isinstance(data, dict):
        return data
    return {}


def _format_value(value: Any) -> str:
    if isinstance(value, dict | list):
        return json.dumps(value)
    return str(value)
