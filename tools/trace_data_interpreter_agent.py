"""Pretty-print Data Interpreter baseline evaluation traces.

Renders JSONL traces emitted by ``DataInterpreterBaselineAgent``. The trace
highlights the MetaGPT-style stages: plan, write_code, reflect_code,
execute_code, and final_answer.

Usage:
    uv run python tools/trace_data_interpreter_agent.py evaluations/<run>/traces/5.jsonl
    uv run python tools/trace_data_interpreter_agent.py traces/titanic.jsonl --expand
    uv run python tools/trace_data_interpreter_agent.py traces/titanic.jsonl \
        --name execute_code
    uv run python tools/trace_data_interpreter_agent.py traces/titanic.jsonl --metadata
"""

import json
import re
from pathlib import Path
from typing import Any

import typer
from rich.console import Console, Group
from rich.markdown import Markdown
from rich.panel import Panel
from rich.syntax import Syntax
from rich.text import Text

console = Console()
app = typer.Typer(
    help="Pretty-print Data Interpreter baseline evaluation traces.",
    no_args_is_help=True,
)

COLLAPSE_THRESHOLD = 900
_PYTHON_BLOCK_RE = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL)
_EVENT_STYLES = {
    "user_requirement": "blue",
    "plan": "cyan",
    "write_code": "green",
    "reflect_code": "red",
    "execute_code": "yellow",
    "final_answer": "bright_green",
}


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
    role: str | None,
    name: str | None,
) -> bool:
    if role is not None and message.get("role") != role:
        return False
    return not (name is not None and message.get("name") != name)


def _truncate(content: str, collapse: int) -> str:
    if len(content) <= collapse:
        return content
    return content[:collapse] + "\n..."


def _extract_python_blocks(content: str) -> list[str]:
    return [match.strip() for match in _PYTHON_BLOCK_RE.findall(content)]


def _strip_python_blocks(content: str) -> str:
    return _PYTHON_BLOCK_RE.sub("[python code shown below]", content).strip()


def _event_name(message: dict[str, Any]) -> str:
    name = message.get("name")
    if isinstance(name, str) and name:
        return name
    role = message.get("role")
    if role == "user":
        return "user_requirement"
    return str(role or "event")


def _panel_title(message: dict[str, Any], index: int) -> str:
    event = _event_name(message)
    usage = message.get("usage_metadata")
    token_label = ""
    if isinstance(usage, dict) and usage.get("total_tokens") is not None:
        token_label = f" ({usage['total_tokens']} tokens)"
    metadata = message.get("metadata")
    detail = ""
    if isinstance(metadata, dict) and event == "execute_code":
        task = metadata.get("task_index")
        attempt = metadata.get("attempt")
        success = metadata.get("success")
        detail = f" task={task} attempt={attempt} success={success}"
    return f"#{index} {event}{detail}{token_label}"


def _render_code_event(content: str, collapse: int) -> Group:
    text_part = _strip_python_blocks(content)
    blocks = _extract_python_blocks(content)
    renderables: list[object] = []
    if text_part:
        renderables.append(Markdown(_truncate(text_part, collapse)))
    for block_index, code in enumerate(blocks, start=1):
        renderables.append(
            Panel(
                Syntax(_truncate(code, collapse), "python", theme="monokai"),
                title=f"Python Code {block_index}",
                border_style="magenta",
            )
        )
    if not renderables:
        renderables.append(Text("<empty content>"))
    return Group(*renderables)


def _render_metadata(metadata: object) -> Syntax | None:
    if metadata in (None, {}):
        return None
    return Syntax(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        "json",
        theme="monokai",
        word_wrap=True,
    )


def _render_message(
    message: dict[str, Any],
    index: int,
    collapse: int,
    *,
    show_metadata: bool,
) -> None:
    event = _event_name(message)
    style = _EVENT_STYLES.get(event, "white")
    content = str(message.get("content") or "")

    if event in {"write_code", "reflect_code"}:
        body: object = _render_code_event(content, collapse)
    elif event in {"plan", "final_answer"}:
        body = Markdown(_truncate(content or "<empty content>", collapse))
    else:
        body = Text(_truncate(content or "<empty content>", collapse))

    console.print(
        Panel(
            body,
            title=_panel_title(message, index),
            border_style=style,
        )
    )

    if show_metadata:
        metadata = _render_metadata(message.get("metadata"))
        if metadata is not None:
            console.print(
                Panel(
                    metadata,
                    title=f"#{index} metadata",
                    border_style="dim",
                )
            )
        usage = _render_metadata(message.get("usage_metadata"))
        if usage is not None:
            console.print(
                Panel(
                    usage,
                    title=f"#{index} usage metadata",
                    border_style="dim",
                )
            )


@app.command()
def main(
    trace_file: Path = typer.Argument(  # noqa: B008
        ...,
        help="Path to a Data Interpreter baseline trace JSONL file.",
        exists=True,
        dir_okay=False,
    ),
    expand: bool = typer.Option(
        False,
        "--expand",
        "-e",
        help="Show full content instead of truncating.",
    ),
    role: str | None = typer.Option(
        None,
        "--role",
        help="Only show messages with this role.",
    ),
    name: str | None = typer.Option(
        None,
        "--name",
        help="Only show messages with this event name.",
    ),
    show_metadata: bool = typer.Option(
        False,
        "--metadata",
        help="Show metadata panels for trace messages.",
    ),
) -> None:
    """Pretty-print a Data Interpreter baseline evaluation trace."""
    collapse = 999_999 if expand else COLLAPSE_THRESHOLD
    messages = [
        message
        for message in _load_messages(trace_file)
        if _matches_filters(message, role=role, name=name)
    ]

    with console.pager(styles=True):
        console.rule(f"[bold blue]{trace_file}")
        console.print(f"[dim]{len(messages)} matching messages[/dim]\n")

        for index, message in enumerate(messages, start=1):
            _render_message(
                message,
                index,
                collapse,
                show_metadata=show_metadata,
            )


if __name__ == "__main__":
    app()
