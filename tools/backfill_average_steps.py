"""Remove obsolete trace-line step statistics from evaluation metadata.

Usage:
    uv run python tools/backfill_average_steps.py evaluations
    uv run python tools/backfill_average_steps.py evaluations/dabench-agent-model-run
"""

import argparse
import json
from pathlib import Path
from typing import Any

from rich.console import Console


def _find_run_dirs(path: Path) -> list[Path]:
    if (path / "meta.json").is_file():
        return [path]
    return sorted(meta.parent for meta in path.rglob("meta.json"))


def _backfill_run(run_dir: Path) -> bool:
    meta_path = run_dir / "meta.json"
    if not meta_path.is_file():
        return False

    meta: dict[str, Any] = json.loads(meta_path.read_text())
    meta.pop("total_steps", None)
    meta.pop("average_steps", None)
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove obsolete step statistics from evaluation runs."
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

    Console().print(f"updated={updated} skipped={skipped}")


if __name__ == "__main__":
    main()
