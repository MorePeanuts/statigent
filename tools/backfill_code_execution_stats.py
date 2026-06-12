"""Backfill code execution statistics in existing evaluation meta.json files.

Usage:
    uv run python tools/backfill_code_execution_stats.py evaluations
    uv run python tools/backfill_code_execution_stats.py evaluations/example-run
"""

import argparse
import json
from pathlib import Path
from typing import cast

from rich.console import Console


def _count_code_lines(code: str) -> int:
    return sum(
        1
        for line in code.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def _event_metadata(event: dict[object, object]) -> dict[object, object]:
    metadata = event.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _read_events(path: Path) -> list[dict[object, object]]:
    events: list[dict[object, object]] = []
    with path.open() as trace:
        for line in trace:
            if not line.strip():
                continue
            try:
                value = cast("object", json.loads(line))
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
    return events


def _trace_code_stats(path: Path) -> tuple[int, int, int]:
    events = _read_events(path)
    failed_cell_ids: set[str] = set()
    for event in events:
        if event.get("agent") != "coder" or event.get("name") != "observation":
            continue
        metadata = _event_metadata(event)
        cell_id = metadata.get("cell_id")
        exit_code = metadata.get("exit_code")
        if isinstance(cell_id, str) and type(exit_code) is int and exit_code != 0:
            failed_cell_ids.add(cell_id)

    total_code_lines = 0
    total_code_blocks = 0
    error_code_blocks = 0
    for event in events:
        if event.get("agent") != "coder" or event.get("name") != "append_code_cell":
            continue
        total_code_blocks += 1
        metadata = _event_metadata(event)
        code = metadata.get("code")
        if isinstance(code, str):
            total_code_lines += _count_code_lines(code)
        cell_id = metadata.get("cell_id")
        if isinstance(cell_id, str) and cell_id in failed_cell_ids:
            error_code_blocks += 1

    return total_code_lines, total_code_blocks, error_code_blocks


def _find_run_dirs(path: Path) -> list[Path]:
    if (path / "meta.json").is_file():
        return [path]
    return sorted(meta.parent for meta in path.rglob("meta.json"))


def _backfill_run(run_dir: Path) -> bool:
    meta_path = run_dir / "meta.json"
    trace_dir = run_dir / "traces"
    if not meta_path.is_file() or not trace_dir.is_dir():
        return False

    total_code_lines = 0
    total_code_blocks = 0
    error_code_blocks = 0
    for trace_path in sorted(trace_dir.rglob("*.jsonl")):
        if not trace_path.is_file():
            continue
        trace_lines, trace_blocks, trace_errors = _trace_code_stats(trace_path)
        total_code_lines += trace_lines
        total_code_blocks += trace_blocks
        error_code_blocks += trace_errors

    error_rate = error_code_blocks / total_code_blocks if total_code_blocks else 0.0
    meta_value = cast("object", json.loads(meta_path.read_text()))
    if not isinstance(meta_value, dict):
        return False
    meta_value["total_code_lines"] = total_code_lines
    meta_value["code_execution_error_rate"] = error_rate
    meta_path.write_text(json.dumps(meta_value, indent=2) + "\n")
    return True


def main() -> None:
    """Backfill code execution statistics for one or more evaluation runs."""
    parser = argparse.ArgumentParser(
        description="Backfill code execution statistics for evaluation runs."
    )
    parser.add_argument(
        "path",
        type=Path,
        help="Evaluation run directory or parent directory containing runs.",
    )
    args = parser.parse_args()

    root = args.path.expanduser().resolve()
    if not root.exists():
        parser.error(f"path does not exist: {root}")

    updated = 0
    skipped = 0
    for run_dir in _find_run_dirs(root):
        if _backfill_run(run_dir):
            updated += 1
        else:
            skipped += 1

    Console().print(f"updated={updated} skipped={skipped}")


if __name__ == "__main__":
    main()
