"""Backfill code execution statistics in existing evaluation meta.json files.

Usage:
    uv run python tools/backfill_code_execution_stats.py evaluations
    uv run python tools/backfill_code_execution_stats.py evaluations/example-run
"""

import argparse
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import cast

from rich.console import Console

_PYTHON_BLOCK_RE = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL)
_FAILED_EXIT_RE = re.compile(r"^\s*Exit code:\s*(-?\d+)", re.IGNORECASE)


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


def _stats(codes: list[str], failed_indexes: set[int]) -> tuple[int, int, int]:
    return (
        sum(_count_code_lines(code) for code in codes),
        len(codes),
        len(failed_indexes),
    )


def _failed_exit(content: object) -> bool:
    if not isinstance(content, str):
        return False
    match = _FAILED_EXIT_RE.match(content)
    return match is not None and int(match.group(1)) != 0


def _statigent_stats(events: list[dict[object, object]]) -> tuple[int, int, int]:
    failed_cell_ids: set[str] = set()
    for event in events:
        if event.get("agent") != "coder" or event.get("name") != "observation":
            continue
        metadata = _event_metadata(event)
        cell_id = metadata.get("cell_id")
        exit_code = metadata.get("exit_code")
        if isinstance(cell_id, str) and type(exit_code) is int and exit_code != 0:
            failed_cell_ids.add(cell_id)

    codes: list[str] = []
    failed_indexes: set[int] = set()
    for event in events:
        if event.get("agent") != "coder" or event.get("name") != "append_code_cell":
            continue
        metadata = _event_metadata(event)
        code = metadata.get("code")
        codes.append(code if isinstance(code, str) else "")
        cell_id = metadata.get("cell_id")
        if isinstance(cell_id, str) and cell_id in failed_cell_ids:
            failed_indexes.add(len(codes) - 1)

    return _stats(codes, failed_indexes)


def _react_stats(events: list[dict[object, object]]) -> tuple[int, int, int]:
    codes: list[str] = []
    call_indexes: dict[str, int] = {}
    for event in events:
        tool_calls = event.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for value in tool_calls:
            if (
                not isinstance(value, dict)
                or value.get("name") not in {"python", "bash"}
            ):
                continue
            args = value.get("args")
            if not isinstance(args, dict):
                continue
            field = "code" if value.get("name") == "python" else "command"
            code = args.get(field)
            if not isinstance(code, str):
                continue
            codes.append(code)
            call_id = value.get("id")
            if isinstance(call_id, str):
                call_indexes[call_id] = len(codes) - 1

    failed_indexes: set[int] = set()
    for event in events:
        call_id = event.get("tool_call_id")
        if (
            isinstance(call_id, str)
            and call_id in call_indexes
            and _failed_exit(event.get("content"))
        ):
            failed_indexes.add(call_indexes[call_id])
    return _stats(codes, failed_indexes)


def _fenced_code_stats(
    events: list[dict[object, object]],
    *,
    code_event_names: set[str] | None,
    result_name: str,
    result_failed: Callable[[dict[object, object]], bool],
) -> tuple[int, int, int]:
    codes: list[str] = []
    results: list[dict[object, object]] = []
    for event in events:
        if code_event_names is not None and event.get("name") not in code_event_names:
            continue
        if code_event_names is None and event.get("role") != "assistant":
            continue
        content = event.get("content")
        if isinstance(content, str):
            codes.extend(_PYTHON_BLOCK_RE.findall(content))
    for event in events:
        if event.get("name") == result_name:
            results.append(event)

    failed_indexes = {
        index
        for index, result in enumerate(results[: len(codes)])
        if result_failed(result)
    }
    return _stats(codes, failed_indexes)


def _data_interpreter_stats(
    events: list[dict[object, object]],
) -> tuple[int, int, int]:
    return _fenced_code_stats(
        events,
        code_event_names={"write_code", "reflect_code"},
        result_name="execute_code",
        result_failed=lambda event: _event_metadata(event).get("success") is False,
    )


def _datawise_stats(events: list[dict[object, object]]) -> tuple[int, int, int]:
    return _fenced_code_stats(
        events,
        code_event_names=None,
        result_name="python",
        result_failed=lambda event: _failed_exit(event.get("content")),
    )


def _trace_code_stats(path: Path) -> tuple[int, int, int]:
    events = _read_events(path)
    if any(event.get("name") == "append_code_cell" for event in events):
        return _statigent_stats(events)
    if any(isinstance(event.get("tool_calls"), list) for event in events):
        return _react_stats(events)
    if any(event.get("name") == "execute_code" for event in events):
        return _data_interpreter_stats(events)
    return _datawise_stats(events)


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
