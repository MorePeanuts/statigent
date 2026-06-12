"""Backfill Statigent subagent token summaries and invocation trends.

Usage:
    uv run python tools/backfill_subagent_token_usage.py evaluations
    uv run python tools/backfill_subagent_token_usage.py evaluations/example-run
"""

import argparse
import json
from pathlib import Path
from typing import cast

from rich.console import Console

TaskSequences = dict[str, dict[str, list[int]]]
AllTaskSequences = dict[str, TaskSequences]
_SUPPORTED_AGENTS = {"statigent", "datawise", "data_interpreter", "react"}


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


def _event_usage(
    event: dict[object, object],
    *,
    run_agent: str = "statigent",
) -> tuple[str, str, int, int] | None:
    if run_agent == "statigent":
        agent = event.get("agent")
        name = event.get("name")
    else:
        if event.get("role") != "assistant":
            return None
        agent = run_agent
        name = event.get("name") if run_agent == "data_interpreter" else "assistant"
        if not isinstance(name, str) or not name:
            name = "assistant"
    usage = event.get("usage_metadata")
    if not isinstance(agent, str) or not isinstance(name, str):
        return None
    if not isinstance(usage, dict):
        return None
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if type(input_tokens) is not int or type(output_tokens) is not int:
        return None
    return agent, name, input_tokens, output_tokens


def _task_sequences(
    events: list[dict[object, object]],
    *,
    run_agent: str = "statigent",
) -> TaskSequences:
    sequences: TaskSequences = {}
    for event in events:
        usage = _event_usage(event, run_agent=run_agent)
        if usage is None:
            continue
        agent, name, input_tokens, _output_tokens = usage
        sequences.setdefault(agent, {}).setdefault(name, []).append(input_tokens)
    return sequences


def _summary(
    usages: list[tuple[str, str, int, int]],
) -> dict[str, dict[str, int | float]]:
    values: dict[str, dict[str, int]] = {}
    for agent, _name, input_tokens, output_tokens in usages:
        current = values.setdefault(
            agent,
            {
                "invocations": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "max_input_tokens": 0,
            },
        )
        current["invocations"] += 1
        current["input_tokens"] += input_tokens
        current["output_tokens"] += output_tokens
        current["max_input_tokens"] = max(current["max_input_tokens"], input_tokens)

    summary: dict[str, dict[str, int | float]] = {}
    for agent, current in sorted(values.items()):
        invocations = current["invocations"]
        summary[agent] = {
            "invocations": invocations,
            "input_tokens": current["input_tokens"],
            "output_tokens": current["output_tokens"],
            "average_input_tokens": current["input_tokens"] / invocations,
            "average_output_tokens": current["output_tokens"] / invocations,
            "max_input_tokens": current["max_input_tokens"],
        }
    return summary


def _trends(
    tasks: AllTaskSequences,
) -> dict[str, dict[str, list[dict[str, int | float]]]]:
    round_values: dict[str, dict[str, list[list[int]]]] = {}
    for task in tasks.values():
        for agent, events in task.items():
            for name, sequence in events.items():
                rounds = round_values.setdefault(agent, {}).setdefault(name, [])
                for index, input_tokens in enumerate(sequence):
                    if index == len(rounds):
                        rounds.append([])
                    rounds[index].append(input_tokens)

    trends: dict[str, dict[str, list[dict[str, int | float]]]] = {}
    for agent, event_rounds in sorted(round_values.items()):
        trends[agent] = {}
        for name, rounds in sorted(event_rounds.items()):
            trends[agent][name] = [
                {
                    "round": index,
                    "samples": len(values),
                    "average_input_tokens": sum(values) / len(values),
                    "max_input_tokens": max(values),
                }
                for index, values in enumerate(rounds, start=1)
            ]
    return trends


def _find_run_dirs(path: Path) -> list[Path]:
    if (path / "meta.json").is_file():
        return [path]
    return sorted(meta.parent for meta in path.rglob("meta.json"))


def _backfill_run(run_dir: Path) -> bool:
    meta_path = run_dir / "meta.json"
    trace_dir = run_dir / "traces"
    if not meta_path.is_file() or not trace_dir.is_dir():
        return False

    meta_value = cast("object", json.loads(meta_path.read_text()))
    if not isinstance(meta_value, dict):
        return False
    run_agent = meta_value.get("agent_name")
    if not isinstance(run_agent, str) or run_agent not in _SUPPORTED_AGENTS:
        return False

    all_usages: list[tuple[str, str, int, int]] = []
    tasks: AllTaskSequences = {}
    for trace_path in sorted(trace_dir.rglob("*.jsonl")):
        if not trace_path.is_file():
            continue
        events = _read_events(trace_path)
        usages = [
            usage
            for event in events
            if (usage := _event_usage(event, run_agent=run_agent)) is not None
        ]
        all_usages.extend(usages)
        task_id = trace_path.relative_to(trace_dir).with_suffix("").as_posix()
        tasks[task_id] = _task_sequences(events, run_agent=run_agent)

    meta_value["subagent_token_usage"] = _summary(all_usages)
    meta_path.write_text(json.dumps(meta_value, indent=2) + "\n")
    detail = {"tasks": tasks, "trends": _trends(tasks)}
    (run_dir / "subagent_token_usage.json").write_text(
        json.dumps(detail, indent=2) + "\n"
    )
    return True


def main() -> None:
    """Backfill subagent token usage for one or more Statigent runs."""
    parser = argparse.ArgumentParser(
        description="Backfill Statigent subagent token summaries and trends."
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
