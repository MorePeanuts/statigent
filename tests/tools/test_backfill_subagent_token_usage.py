import json
from collections.abc import Callable
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType


def _load_script() -> ModuleType:
    script_path = (
        Path(__file__).parents[2] / "tools" / "backfill_subagent_token_usage.py"
    )
    spec = spec_from_file_location("backfill_subagent_token_usage", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _usage_event(
    agent: str,
    name: str,
    input_tokens: object,
    output_tokens: object,
) -> dict[str, object]:
    return {
        "agent": agent,
        "name": name,
        "usage_metadata": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        },
    }


def _write_trace(path: Path, events: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(event) for event in events) + "\n")


def test_backfill_run_writes_summary_task_sequences_and_trends(
    tmp_path: Path,
) -> None:
    backfill_run = _load_script()._backfill_run
    assert isinstance(backfill_run, Callable)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "meta.json").write_text(
        json.dumps({"agent_name": "statigent", "model_name": "test"})
    )
    _write_trace(
        run_dir / "traces" / "1.jsonl",
        [
            _usage_event("inspector", "plan", 100, 10),
            _usage_event("coder", "append_code_cell", 200, 20),
            _usage_event("inspector", "plan", 300, 30),
        ],
    )
    nested_trace = run_dir / "traces" / "competition" / "2.jsonl"
    _write_trace(
        nested_trace,
        [
            _usage_event("inspector", "plan", 150, 15),
            _usage_event("inspector", "final_draft", 400, 40),
            _usage_event("coder", "append_code_cell", "invalid", 99),
        ],
    )
    with nested_trace.open("a") as trace:
        trace.write("not-json\n")

    assert backfill_run(run_dir) is True

    meta = json.loads((run_dir / "meta.json").read_text())
    assert meta["model_name"] == "test"
    assert meta["subagent_token_usage"] == {
        "coder": {
            "invocations": 1,
            "input_tokens": 200,
            "output_tokens": 20,
            "average_input_tokens": 200.0,
            "average_output_tokens": 20.0,
            "max_input_tokens": 200,
        },
        "inspector": {
            "invocations": 4,
            "input_tokens": 950,
            "output_tokens": 95,
            "average_input_tokens": 237.5,
            "average_output_tokens": 23.75,
            "max_input_tokens": 400,
        },
    }

    detail = json.loads((run_dir / "subagent_token_usage.json").read_text())
    assert detail["tasks"] == {
        "1": {
            "coder": {"append_code_cell": [200]},
            "inspector": {"plan": [100, 300]},
        },
        "competition/2": {
            "inspector": {"final_draft": [400], "plan": [150]},
        },
    }
    assert detail["trends"]["inspector"]["plan"] == [
        {
            "round": 1,
            "samples": 2,
            "average_input_tokens": 125.0,
            "max_input_tokens": 150,
        },
        {
            "round": 2,
            "samples": 1,
            "average_input_tokens": 300.0,
            "max_input_tokens": 300,
        },
    ]


def test_backfill_run_maps_baseline_events_to_single_agent(tmp_path: Path) -> None:
    backfill_run = _load_script()._backfill_run
    assert isinstance(backfill_run, Callable)
    cases = [
        (
            "datawise",
            [
                {
                    "role": "assistant",
                    "usage_metadata": {"input_tokens": 100, "output_tokens": 10},
                }
            ],
            "assistant",
        ),
        (
            "data_interpreter",
            [
                {
                    "role": "assistant",
                    "name": "write_code",
                    "usage_metadata": {"input_tokens": 200, "output_tokens": 20},
                }
            ],
            "write_code",
        ),
        (
            "react",
            [
                {
                    "role": "assistant",
                    "usage_metadata": {"input_tokens": 300, "output_tokens": 30},
                }
            ],
            "assistant",
        ),
    ]
    for agent_name, events, event_name in cases:
        run_dir = tmp_path / agent_name
        run_dir.mkdir()
        (run_dir / "meta.json").write_text(json.dumps({"agent_name": agent_name}))
        _write_trace(run_dir / "traces" / "1.jsonl", events)

        assert backfill_run(run_dir) is True

        detail = json.loads((run_dir / "subagent_token_usage.json").read_text())
        expected_input = events[0]["usage_metadata"]["input_tokens"]  # type: ignore[index]
        assert detail["tasks"]["1"][agent_name][event_name] == [expected_input]
        meta = json.loads((run_dir / "meta.json").read_text())
        assert meta["subagent_token_usage"][agent_name]["invocations"] == 1


def test_backfill_run_skips_unsupported_agent_run(tmp_path: Path) -> None:
    backfill_run = _load_script()._backfill_run
    assert isinstance(backfill_run, Callable)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "meta.json").write_text(json.dumps({"agent_name": "unknown"}))
    _write_trace(
        run_dir / "traces" / "1.jsonl",
        [_usage_event("assistant", "message", 100, 10)],
    )

    assert backfill_run(run_dir) is False
    assert not (run_dir / "subagent_token_usage.json").exists()
