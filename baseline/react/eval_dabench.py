"""Evaluate agents on DABench benchmark."""

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from statigent.baseline import ReactBaselineAgent
from statigent.benchmarks.dabench import DABenchAdapter
from statigent.models import load_registry

_DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parent.parent.parent / "config" / "models.toml"
)


def main(
    output_dir: Annotated[
        Path,
        typer.Option(
            help="Directory for evaluation results.",
            dir_okay=True,
            file_okay=False,
        ),
    ] = Path("evaluations"),
    limit: Annotated[
        int | None,
        typer.Option(help="Number of questions to evaluate. Defaults to all."),
    ] = None,
    task_id: Annotated[
        str | None,
        typer.Option(
            help="Run a specific question by its ID (e.g. 5).",
        ),
    ] = None,
    model: Annotated[
        str,
        typer.Option(help="Model profile name from defaults.toml."),
    ] = "deepseek-v4-flash",
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

    path = registry_path or _DEFAULT_REGISTRY_PATH
    if not path.exists():
        console.print(f"[red]Registry file not found: {path}[/red]")
        console.print("Create config/models.toml or pass --registry-path")
        raise typer.Exit(code=1)
    registry = load_registry(str(path))
    if not registry.has_model(model):
        available = ", ".join(registry.list_models())
        console.print(f"[red]Unknown model: {model}. Available: {available}[/red]")
        raise typer.Exit(code=1)

    console.print("[bold]DABench Evaluation[/bold]")
    console.print(f"  Model: {model}")
    console.print(f"  Limit: {limit or 'all'}")
    console.print(f"  Task ID: {task_id or 'all'}")
    console.print(f"  Output: {output_dir}")
    console.print(f"  Registry: {path}")

    # Setup
    adapter = DABenchAdapter()
    agent = ReactBaselineAgent(model_name=model)

    # Prepare
    console.print("\n[blue]Preparing DABench data...[/blue]")
    adapter.prepare()
    total = len(adapter._questions)
    console.print(f"  {total} questions available")

    # Execute full pipeline (prepare -> run -> evaluate -> persist)
    console.print("\n[blue]Running evaluation...[/blue]")
    kwargs: dict = {"output_dir": str(output_dir)}
    if limit is not None:
        kwargs["limit"] = limit
    if task_id is not None:
        kwargs["task_id"] = task_id

    result = adapter.execute(agent, **kwargs)

    # Display results
    table = Table(title="Evaluation Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")
    table.add_row("ABQ", f"{result.details.get('abq', 'N/A')}")
    table.add_row("PSAQ", f"{result.details.get('psaq', 'N/A')}")
    table.add_row("UASQ", f"{result.details.get('uasq', 'N/A')}")
    table.add_row("Agent", result.agent_name)
    table.add_row("Model", result.model_name)
    table.add_row("Score", f"{result.score:.4f}")
    console.print(table)

    n = result.details.get("total", "?")
    console.print(f"\n[bold green]Done — evaluated {n} questions[/bold green]")


if __name__ == "__main__":
    typer.run(main)
