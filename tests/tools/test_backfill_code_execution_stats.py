import json
from collections.abc import Callable
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any


def _load_script() -> ModuleType:
    script_path = (
        Path(__file__).parents[2] / "tools" / "backfill_code_execution_stats.py"
    )
    spec = spec_from_file_location("backfill_code_execution_stats", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _event(
    name: str,
    *,
    cell_id: str | None = None,
    code: str | None = None,
    exit_code: object | None = None,
) -> dict[str, Any]:
    metadata: dict[str, object] = {}
    if cell_id is not None:
        metadata["cell_id"] = cell_id
    if code is not None:
        metadata["code"] = code
    if exit_code is not None:
        metadata["exit_code"] = exit_code
    return {
        "agent": "coder",
        "name": name,
        "metadata": metadata,
    }


def _write_trace(path: Path, events: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(event) for event in events) + "\n")


def test_count_code_lines_excludes_blank_and_pure_comment_lines() -> None:
    count_code_lines = _load_script()._count_code_lines
    assert isinstance(count_code_lines, Callable)

    code = "x = 1\n\n# comment\n  # indented comment\nprint(x)  # inline comment\n"

    assert count_code_lines(code) == 2


def test_trace_code_stats_counts_failed_matched_observations(tmp_path: Path) -> None:
    trace_code_stats = _load_script()._trace_code_stats
    assert isinstance(trace_code_stats, Callable)
    trace_path = tmp_path / "trace.jsonl"
    _write_trace(
        trace_path,
        [
            _event("append_code_cell", cell_id="cell-1", code="x = 1\n"),
            _event("observation", cell_id="cell-1", exit_code=0),
            _event("append_code_cell", cell_id="cell-2", code="# note\nraise Error\n"),
            _event("observation", cell_id="cell-2", exit_code=1),
            _event("append_code_cell", cell_id="cell-3", code="\nprint('ok')\n"),
            _event("observation", cell_id="cell-3", exit_code="1"),
        ],
    )

    assert trace_code_stats(trace_path) == (3, 3, 1)


def test_trace_code_stats_counts_datawise_python_blocks(tmp_path: Path) -> None:
    trace_code_stats = _load_script()._trace_code_stats
    assert isinstance(trace_code_stats, Callable)
    trace_path = tmp_path / "trace.jsonl"
    _write_trace(
        trace_path,
        [
            {
                "role": "assistant",
                "content": (
                    "First\n```python\nx = 1\n# note\n\nprint(x)\n```\n"
                    "Second\n```py\nraise ValueError()\n```"
                ),
            },
            {"role": "tool", "name": "python", "content": "1\n"},
            {
                "role": "tool",
                "name": "python",
                "content": "Exit code: 1\nTraceback...",
            },
        ],
    )

    assert trace_code_stats(trace_path) == (3, 2, 1)


def test_trace_code_stats_counts_data_interpreter_attempts(tmp_path: Path) -> None:
    trace_code_stats = _load_script()._trace_code_stats
    assert isinstance(trace_code_stats, Callable)
    trace_path = tmp_path / "trace.jsonl"
    _write_trace(
        trace_path,
        [
            {
                "role": "assistant",
                "name": "write_code",
                "content": "```python\nx = 1\n# comment\n```",
            },
            {
                "role": "tool",
                "name": "execute_code",
                "content": "ok",
                "metadata": {"success": True},
            },
            {
                "role": "assistant",
                "name": "reflect_code",
                "content": "```python\nraise ValueError()\n```",
            },
            {
                "role": "tool",
                "name": "execute_code",
                "content": "Exit code: 1",
                "metadata": {"success": False},
            },
        ],
    )

    assert trace_code_stats(trace_path) == (2, 2, 1)


def test_trace_code_stats_counts_react_python_and_bash_calls(tmp_path: Path) -> None:
    trace_code_stats = _load_script()._trace_code_stats
    assert isinstance(trace_code_stats, Callable)
    trace_path = tmp_path / "trace.jsonl"
    _write_trace(
        trace_path,
        [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "name": "python",
                        "args": {"code": "x = 1\n# note\nprint(x)\n"},
                        "id": "python-1",
                    },
                    {
                        "name": "bash",
                        "args": {"command": "# inspect\nls -la\n"},
                        "id": "bash-1",
                    },
                    {
                        "name": "read_file",
                        "args": {"file_path": "data.csv"},
                        "id": "read-1",
                    },
                ],
            },
            {
                "role": "tool",
                "name": "python",
                "content": "1",
                "tool_call_id": "python-1",
            },
            {
                "role": "tool",
                "name": "bash",
                "content": "Exit code: 2\nls: error",
                "tool_call_id": "bash-1",
            },
        ],
    )

    assert trace_code_stats(trace_path) == (3, 2, 1)


def test_backfill_run_updates_meta_from_nested_traces(tmp_path: Path) -> None:
    backfill_run = _load_script()._backfill_run
    assert isinstance(backfill_run, Callable)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "meta.json").write_text(json.dumps({"agent_name": "statigent"}))
    _write_trace(
        run_dir / "traces" / "1.jsonl",
        [
            _event("append_code_cell", cell_id="cell-1", code="x = 1\n"),
            _event("observation", cell_id="cell-1", exit_code=1),
        ],
    )
    nested_trace = run_dir / "traces" / "competition" / "2.jsonl"
    _write_trace(
        nested_trace,
        [
            _event("append_code_cell", cell_id="cell-2", code="# note\n\nprint(2)\n"),
            _event("observation", cell_id="cell-2", exit_code=0),
        ],
    )
    with nested_trace.open("a") as trace:
        trace.write("not-json\n")

    assert backfill_run(run_dir) is True

    meta = json.loads((run_dir / "meta.json").read_text())
    assert meta == {
        "agent_name": "statigent",
        "total_code_lines": 2,
        "code_execution_error_rate": 0.5,
    }


def test_backfill_run_records_zero_rate_without_code_blocks(tmp_path: Path) -> None:
    backfill_run = _load_script()._backfill_run
    assert isinstance(backfill_run, Callable)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "meta.json").write_text("{}")
    _write_trace(run_dir / "traces" / "1.jsonl", [_event("observation")])

    assert backfill_run(run_dir) is True

    meta = json.loads((run_dir / "meta.json").read_text())
    assert meta["total_code_lines"] == 0
    assert meta["code_execution_error_rate"] == 0.0
