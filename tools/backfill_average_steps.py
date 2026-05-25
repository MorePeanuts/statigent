"""Backfill step statistics in existing evaluation meta.json files.

Usage:
    uv run python tools/backfill_average_steps.py evaluations
    uv run python tools/backfill_average_steps.py evaluations/dabench-agent-model-run
"""

import argparse
import json
from pathlib import Path
from typing import Any


def _trace_step_count(path: Path) -> int:
    with open(path) as f:
        return sum(1 for line in f if line.strip())


def _find_run_dirs(path: Path) -> list[Path]:
    if (path / "meta.json").is_file():
        return [path]
    return sorted(meta.parent for meta in path.rglob("meta.json"))


def _backfill_run(run_dir: Path) -> bool:
    meta_path = run_dir / "meta.json"
    trace_dir = run_dir / "traces"
    if not meta_path.is_file() or not trace_dir.is_dir():
        return False

    trace_files = sorted(path for path in trace_dir.rglob("*.jsonl") if path.is_file())
    completed_tasks = len(trace_files)
    total_steps = sum(_trace_step_count(path) for path in trace_files)
    average_steps = total_steps / completed_tasks if completed_tasks else 0.0

    meta: dict[str, Any] = json.loads(meta_path.read_text())
    meta["total_steps"] = total_steps
    meta["completed_tasks"] = completed_tasks
    meta["average_steps"] = average_steps
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill average step statistics for evaluation runs."
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

    run_dirs = _find_run_dirs(root)
    updated = 0
    skipped = 0
    for run_dir in run_dirs:
        if _backfill_run(run_dir):
            updated += 1
        else:
            skipped += 1

    print(f"updated={updated} skipped={skipped}")


if __name__ == "__main__":
    main()
