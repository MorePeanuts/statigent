"""Pretty-print Datawise baseline evaluation traces.

Renders JSONL traces emitted by ``DatawiseBaselineAgent`` as readable panels.
The trace schema is:

  user:       {role, content}
  assistant:  {role, content, usage_metadata?}
  tool:       {role, name: "python", content}

Usage:
    uv run python tools/trace_datawise_agent.py evaluations/<run>/traces/5.jsonl
    uv run python tools/trace_datawise_agent.py traces/titanic.jsonl --expand
    uv run python tools/trace_datawise_agent.py traces/titanic.jsonl --role tool
    uv run python tools/trace_datawise_agent.py traces/titanic.jsonl --metadata
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
    help="Pretty-print Datawise baseline evaluation traces.",
    no_args_is_help=True,
)

COLLAPSE_THRESHOLD = 900
_PYTHON_BLOCK_RE = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL)
_ROLE_STYLES = {
    "user": "blue",
    "assistant": "green",
    "tool": "yellow",
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


def _matches_filters(message: dict[str, Any], *, role: str | None) -> bool:
    return role is None or message.get("role") == role


def _truncate(content: str, collapse: int) -> str:
    if len(content) <= collapse:
        return content
    return content[:collapse] + "\n..."


def _strip_python_blocks(content: str) -> str:
    return _PYTHON_BLOCK_RE.sub("[python code cell shown below]", content).strip()


def _extract_python_blocks(content: str) -> list[str]:
    return [match.strip() for match in _PYTHON_BLOCK_RE.findall(content)]


def _panel_title(message: dict[str, Any], index: int) -> str:
    role = str(message.get("role") or "unknown")
    if role == "user":
        return f"#{index} User Task"
    if role == "assistant":
        marker = _first_control_marker(str(message.get("content") or ""))
        usage = message.get("usage_metadata")
        token_label = ""
        if isinstance(usage, dict) and usage.get("total_tokens") is not None:
            token_label = f" ({usage['total_tokens']} tokens)"
        if marker:
            return f"#{index} Assistant {marker}{token_label}"
        return f"#{index} Assistant{token_label}"
    if role == "tool":
        return f"#{index} Python Output"
    return f"#{index} {role}"


def _first_control_marker(content: str) -> str:
    for marker in (
        "<await>",
        "<end_step>",
        "<end_debug>",
        "<debug_success>",
        "<debug_failure>",
    ):
        if marker in content[:200]:
            return marker
    return ""


def _render_assistant(content: str, collapse: int) -> Group:
    text_part = _strip_python_blocks(content)
    blocks = _extract_python_blocks(content)
    renderables: list[object] = []
    if text_part:
        renderables.append(Markdown(_truncate(text_part, collapse)))
    for block_index, code in enumerate(blocks, start=1):
        renderables.append(
            Panel(
                Syntax(_truncate(code, collapse), "python", theme="monokai"),
                title=f"Python Cell {block_index}",
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
    role = str(message.get("role") or "unknown")
    style = _ROLE_STYLES.get(role, "white")
    content = str(message.get("content") or "")

    if role == "assistant":
        body: object = _render_assistant(content, collapse)
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
        metadata = _render_metadata(message.get("usage_metadata"))
        if metadata is not None:
            console.print(
                Panel(
                    metadata,
                    title=f"#{index} usage metadata",
                    border_style="dim",
                )
            )


@app.command()
def main(
    trace_file: Path = typer.Argument(  # noqa: B008
        ...,
        help="Path to a Datawise baseline trace JSONL file.",
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
        help="Only show messages with this role: user, assistant, or tool.",
    ),
    show_metadata: bool = typer.Option(
        False,
        "--metadata",
        help="Show usage metadata panels for assistant messages.",
    ),
) -> None:
    """Pretty-print a Datawise baseline evaluation trace."""
    collapse = 999_999 if expand else COLLAPSE_THRESHOLD
    messages = [
        message
        for message in _load_messages(trace_file)
        if _matches_filters(message, role=role)
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
