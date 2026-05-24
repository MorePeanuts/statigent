"""Test whether the model can connect."""

from pathlib import Path
from typing import Annotated

import typer
from langchain.tools import tool
from pydantic import BaseModel, Field
from rich.console import Console
from rich.markdown import Markdown
from rich.rule import Rule

from statigent.models import get_model, load_registry

_DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parents[1] / "config/models.toml"


class ContactInfo(BaseModel):
    """Contact information for a person."""

    name: str = Field(description="The name of the person")
    email: str = Field(description="The email address of the person")
    phone: str = Field(description="The phone number of the person")


@tool
def add(a: int, b: int) -> int:
    """
    Add two integers.
    """
    return a + b


def main(
    model: Annotated[
        str,
        typer.Argument(help="Model profile name from models.toml or defaults.toml"),
    ],
    registry_path: Annotated[
        Path | None,
        typer.Option(
            help="Path to model registry TOML file.",
            dir_okay=False,
            file_okay=True,
        ),
    ] = None,
) -> None:
    console = Console()

    if registry_path is not None:
        if registry_path.exists():
            path = str(registry_path)
        else:
            console.print(
                f"[yellow]Registry file not found: {registry_path}, "
                "falling back to bundled defaults[/yellow]"
            )
            path = None
    elif _DEFAULT_REGISTRY_PATH.exists():
        path = str(_DEFAULT_REGISTRY_PATH)
    else:
        path = None

    registry = load_registry(path)
    if not registry.has_model(model):
        available = ", ".join(registry.list_models())
        console.print(f"[red]Unknown model: {model}. Available: {available}[/red]")
        raise typer.Exit(code=1)

    llm = get_model(model)

    msg = llm.invoke("Hello, please introduce yourself.").content
    console.print(Rule("text message", style="green"))
    console.print(Markdown(str(msg)))

    llm_with_tools = llm.bind_tools([add])
    msg = llm_with_tools.invoke("Add 53345 and 99238 with tool `add`.").tool_calls[0]
    console.print(Rule("tool usage", style="green"))
    console.print(Markdown(str(msg)))

    llm_with_structured_output = llm.with_structured_output(ContactInfo)
    res = llm_with_structured_output.invoke(
        "Extract contact info from: John Doe, john@example.com, (555) 123-4567"
    )

    console.print(Rule("structured output", style="green"))
    console.print(res)


if __name__ == "__main__":
    typer.run(main)
