"""Evaluate React baseline agent on DSBench data modeling tasks."""

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from statigent.baseline import ReactBaselineAgent
from statigent.benchmarks.dsbench import DSBenchAdapter
from statigent.models import ModelRegistry


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
        typer.Option(help="Number of competitions to evaluate. Defaults to all."),
    ] = None,
    task_id: Annotated[
        str | None,
        typer.Option(
            help="Run a specific competition by name (e.g. titanic).",
        ),
    ] = None,
    model: Annotated[
        str,
        typer.Option(help="Model profile name from defaults.toml."),
    ] = "deepseek-v4-flash",
) -> None:
    console = Console()

    registry = ModelRegistry.load_registry()
    if not registry.has_model(model):
        available = ", ".join(registry.list_models())
        console.print(f"[red]Unknown model: {model}. Available: {available}[/red]")
        raise typer.Exit(code=1)

    console.print("[bold]DSBench Data Modeling Evaluation[/bold]")
    console.print(f"  Agent model: {model}")
    console.print(f"  Limit: {limit or 'all'}")
    console.print(f"  Task ID: {task_id or 'all'}")
    console.print(f"  Output: {output_dir}")

    adapter = DSBenchAdapter(task="data_modeling")
    agent = ReactBaselineAgent(model_name=model)

    console.print("\n[blue]Preparing DSBench data modeling data...[/blue]")
    adapter.prepare()
    total = len(adapter._samples)
    console.print(f"  {total} competitions available")

    console.print("\n[blue]Running evaluation...[/blue]")
    kwargs: dict = {"output_dir": str(output_dir)}
    if limit is not None:
        kwargs["limit"] = limit
    if task_id is not None:
        kwargs["task_id"] = task_id

    result = adapter.execute(agent, **kwargs)

    table = Table(title="Evaluation Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")
    table.add_row(
        "Normalized Score",
        f"{result.score:.4f}",
    )
    table.add_row(
        "Task Completion",
        f"{result.details.get('task_completion_rate', 'N/A')}",
    )
    table.add_row(
        "Total Competitions",
        str(result.details.get("total_competitions", "N/A")),
    )
    table.add_row("Agent", result.agent_name)
    table.add_row("Model", result.model_name)
    console.print(table)

    n = result.details.get("total_competitions", "?")
    completed = sum(
        1
        for c in result.details.get("per_competition", [])
        if c.get("raw_score") is not None
    )
    console.print(
        f"\n[bold green]Done — evaluated {completed}/{n} competitions[/bold green]"
    )


if __name__ == "__main__":
    typer.run(main)
