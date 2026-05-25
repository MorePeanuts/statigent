"""Pretty-print a Statigent data science agent evaluation trace.

Renders a JSONL trace file as readable panels grouped by agent, session, and
event name. This tool targets traces emitted by StatigentDataScienceAgent,
where each event is a serialized TraceEvent.

Usage:
    uv run python tools/trace_statigent.py evaluations/<run>/traces/0001.jsonl
    uv run python tools/trace_statigent.py traces/0001.jsonl --agent inspector
    uv run python tools/trace_statigent.py traces/0001.jsonl --expand
    uv run python tools/trace_statigent.py traces/0001.jsonl --metadata
"""

import json
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.syntax import Syntax

console = Console()
app = typer.Typer(
    help="Pretty-print a Statigent data science agent evaluation trace.",
    no_args_is_help=True,
)

COLLAPSE_THRESHOLD = 700
_AGENT_STYLES = {
    "input_profiler": "blue",
    "task_brief_planner": "cyan",
    "data_science_agent": "bright_blue",
    "inspector": "green",
    "reviewer": "yellow",
    "coder": "magenta",
    "debugger": "red",
    "executor": "bright_magenta",
    "output_renderer": "bright_green",
}
_CELL_EVENT_NAMES = {"append_code_cell", "execute_cell", "debug_cell"}


def _load_messages(trace_file: Path) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    with open(trace_file) as f:
        for line_number, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as err:
                raise typer.BadParameter(
                    f"Invalid JSON on line {line_number}: {err.msg}"
                ) from err
            if not isinstance(value, dict):
                raise typer.BadParameter(
                    f"Trace line {line_number} must be a JSON object"
                )
            messages.append(value)
    return messages


def _matches_filters(
    message: dict[str, Any],
    *,
    agent: str | None,
    name: str | None,
) -> bool:
    if agent is not None and message.get("agent") != agent:
        return False
    return not (name is not None and message.get("name") != name)


def _truncate(content: str, collapse: int) -> str:
    if len(content) <= collapse:
        return content
    return content[:collapse] + "\n..."


def _render_content(
    content: str,
    collapse: int,
    *,
    agent: str,
    name: str,
) -> Markdown | Syntax:
    display = _truncate(content, collapse)
    if agent in {"coder", "debugger"} and name in {
        "append_code_cell",
        "debug_cell",
    }:
        return Syntax(display, "python", theme="monokai", word_wrap=True)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return Markdown(display)
    return Syntax(
        json.dumps(parsed, ensure_ascii=False, indent=2),
        "json",
        theme="monokai",
        word_wrap=True,
    )


def _render_metadata(metadata: object) -> Syntax | None:
    if metadata in (None, {}):
        return None
    return Syntax(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        "json",
        theme="monokai",
        word_wrap=True,
    )


def _panel_title(message: dict[str, Any], index: int) -> str:
    agent = str(message.get("agent") or "unknown")
    session = message.get("session", "?")
    name = str(message.get("name") or "event")
    role = str(message.get("role") or "?")
    metadata = message.get("metadata")
    cell_label = ""
    if isinstance(metadata, dict) and name in _CELL_EVENT_NAMES:
        cell_id = metadata.get("cell_id")
        if cell_id:
            cell_label = f" cell={cell_id}"
    return f"#{index} {agent} s{session} - {name}{cell_label} ({role})"


def _render_message(
    message: dict[str, Any],
    index: int,
    collapse: int,
    *,
    show_metadata: bool,
) -> None:
    agent = str(message.get("agent") or "unknown")
    style = _AGENT_STYLES.get(agent, "white")
    name = str(message.get("name") or "")
    content = str(message.get("content") or "")
    metadata = _render_metadata(message.get("metadata")) if show_metadata else None

    if content:
        console.print(
            Panel(
                _render_content(content, collapse, agent=agent, name=name),
                title=_panel_title(message, index),
                border_style=style,
            )
        )
    else:
        console.print(
            Panel(
                "[dim]<empty content>[/dim]",
                title=_panel_title(message, index),
                border_style=style,
            )
        )

    if metadata is not None:
        console.print(
            Panel(
                metadata,
                title=f"#{index} metadata",
                border_style="dim",
            )
        )


@app.command()
def main(
    trace_file: Path = typer.Argument(  # noqa: B008
        ...,
        help="Path to a Statigent trace JSONL file.",
        exists=True,
        dir_okay=False,
    ),
    expand: bool = typer.Option(
        False,
        "--expand",
        "-e",
        help="Show full event content instead of truncating.",
    ),
    agent: str | None = typer.Option(
        None,
        "--agent",
        help="Only show trace events emitted by this agent.",
    ),
    name: str | None = typer.Option(
        None,
        "--name",
        help="Only show trace events with this event name.",
    ),
    show_metadata: bool = typer.Option(
        False,
        "--metadata",
        help="Show structured metadata panels for each trace event.",
    ),
) -> None:
    """Pretty-print a Statigent data science agent evaluation trace."""
    collapse = 999_999 if expand else COLLAPSE_THRESHOLD
    messages = [
        message
        for message in _load_messages(trace_file)
        if _matches_filters(message, agent=agent, name=name)
    ]

    with console.pager(styles=True):
        console.rule(f"[bold blue]{trace_file}")
        console.print(f"[dim]{len(messages)} matching events[/dim]\n")

        for index, message in enumerate(messages, start=1):
            _render_message(
                message,
                index,
                collapse,
                show_metadata=show_metadata,
            )


if __name__ == "__main__":
    app()
