"""Pretty-print a React agent evaluation trace.

Renders a JSONL trace file as a readable conversation with color-coded
roles, syntax-highlighted tool calls, and collapsed long output.

Trace schema (from statigent.baseline.react._serialize_messages):
  user:       {role, content}
  assistant:  {role, content, tool_calls?: [{name, args, id}]}
  tool:       {role, name, content, tool_call_id}

Usage:
    uv run python tools/trace_react_agent.py evaluations/<run>/traces/titanic.jsonl
    uv run python tools/trace_react_agent.py traces/titanic.jsonl --expand
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
    help="Pretty-print a React agent evaluation trace.",
    no_args_is_help=True,
)

COLLAPSE_THRESHOLD = 300


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _render_user(content: str, collapse: int) -> None:
    display = content[:collapse] + "\n…" if len(content) > collapse else content
    console.print(Panel(display, title="User", border_style="blue"))


def _render_assistant(msg: dict[str, Any]) -> None:
    content: str = msg.get("content", "")
    tool_calls: list[dict[str, Any]] = msg.get("tool_calls", [])

    if content:
        console.print(Panel(Markdown(content), title="Assistant", border_style="green"))

    for tc in tool_calls:
        name: str = tc.get("name", "?")
        args: dict[str, Any] = tc.get("args", {})
        title = f"Tool Call: {name}"

        if name == "python" and "code" in args:
            console.print(
                Panel(
                    Syntax(args["code"], "python", theme="monokai"),
                    title=title,
                    border_style="magenta",
                )
            )
        elif name == "bash" and "command" in args:
            console.print(
                Panel(
                    Syntax(args["command"], "bash", theme="monokai"),
                    title=title,
                    border_style="magenta",
                )
            )
        else:
            console.print(
                Panel(
                    json.dumps(args, ensure_ascii=False),
                    title=title,
                    border_style="magenta",
                )
            )


def _render_tool(msg: dict[str, Any], collapse: int) -> None:
    name: str = msg.get("name", "?")
    content: str = msg.get("content", "")

    display = content[:collapse] + " …" if len(content) > collapse else content

    console.print(Panel(display, title=f"Tool Result: {name}", border_style="yellow"))


def _render_message(msg: dict[str, Any], collapse: int) -> None:
    role: str = msg.get("role", "")
    match role:
        case "user":
            _render_user(msg.get("content", ""), collapse)
        case "assistant":
            _render_assistant(msg)
        case "tool":
            _render_tool(msg, collapse)
        case _:
            console.print(Panel(json.dumps(msg, ensure_ascii=False), title=role))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@app.command()
def main(
    trace_file: Path = typer.Argument(  # noqa: B008
        ...,
        help="Path to a trace JSONL file.",
        exists=True,
    ),
    expand: bool = typer.Option(
        False,
        "--expand",
        "-e",
        help="Show full tool output instead of truncating.",
    ),
) -> None:
    """Pretty-print a React agent evaluation trace."""
    collapse = 999_999 if expand else COLLAPSE_THRESHOLD

    messages: list[dict[str, Any]] = []
    with open(trace_file) as f:
        for line in f:
            line = line.strip()
            if line:
                messages.append(json.loads(line))

    console.rule(f"[bold blue]{trace_file}")
    console.print(f"[dim]{len(messages)} messages[/dim]\n")

    for msg in messages:
        _render_message(msg, collapse)


if __name__ == "__main__":
    app()
