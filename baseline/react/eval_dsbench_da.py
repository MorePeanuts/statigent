"""Evaluate React baseline agent on DSBench data analysis tasks."""

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
        typer.Option(help="Number of samples to evaluate. Defaults to all."),
    ] = None,
    model: Annotated[
        str,
        typer.Option(help="Model profile name from defaults.toml."),
    ] = "deepseek-v4-flash",
    judge_model: Annotated[
        str,
        typer.Option(help="Model used as LLM judge for scoring."),
    ] = "deepseek-v4-flash",
) -> None:
    console = Console()

    registry = ModelRegistry.load_registry()
    if not registry.has_model(model):
        available = ", ".join(registry.list_models())
        console.print(f"[red]Unknown model: {model}. Available: {available}[/red]")
        raise typer.Exit(code=1)

    console.print("[bold]DSBench Data Analysis Evaluation[/bold]")
    console.print(f"  Agent model: {model}")
    console.print(f"  Judge model: {judge_model}")
    console.print(f"  Limit: {limit or 'all'}")
    console.print(f"  Output: {output_dir}")

    adapter = DSBenchAdapter(
        task="data_analysis",
        judge_model_name=judge_model,
    )
    agent = ReactBaselineAgent(model_name=model)

    console.print("\n[blue]Preparing DSBench data analysis data...[/blue]")
    adapter.prepare()
    total = len(adapter._samples)
    console.print(f"  {total} samples available")

    console.print("\n[blue]Running evaluation...[/blue]")
    kwargs: dict = {"output_dir": str(output_dir)}
    if limit is not None:
        kwargs["limit"] = limit

    result = adapter.execute(agent, **kwargs)

    table = Table(title="Evaluation Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")
    table.add_row("Accuracy", f"{result.score:.4f}")
    table.add_row("Total Questions", str(result.details.get("total", "N/A")))
    table.add_row("Agent", result.agent_name)
    table.add_row("Model", result.model_name)
    table.add_row("Judge", judge_model)
    console.print(table)

    n = limit or total
    console.print(f"\n[bold green]Done — evaluated {n} samples[/bold green]")


if __name__ == "__main__":
    typer.run(main)
