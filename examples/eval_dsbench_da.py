"""Evaluate StatigentDataScienceAgent on DSBench data analysis tasks."""

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from statigent.agents import StatigentDataScienceAgent
from statigent.benchmarks.dsbench import DSBenchAdapter
from statigent.models import load_registry

_DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "models.toml"
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
            help=(
                "Run a specific sample or question. "
                "Sample ID (e.g. 00000001) or question ID "
                "(e.g. 00000001/question6)."
            ),
        ),
    ] = None,
    model: Annotated[
        str,
        typer.Option(help="Model profile name from the model registry."),
    ] = "deepseek-v4-flash",
    judge_model: Annotated[
        str,
        typer.Option(help="Model used as LLM judge for scoring."),
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
    """Run DSBench data analysis evaluation with the Statigent agent."""
    console = Console()
    path = _resolve_registry_path(registry_path, console)
    registry = load_registry(path)
    if not registry.has_model(model):
        available = ", ".join(registry.list_models())
        console.print(f"[red]Unknown model: {model}. Available: {available}[/red]")
        raise typer.Exit(code=1)
    if not registry.has_model(judge_model):
        available = ", ".join(registry.list_models())
        console.print(
            f"[red]Unknown judge model: {judge_model}. Available: {available}[/red]"
        )
        raise typer.Exit(code=1)

    console.print("[bold]DSBench Data Analysis Evaluation[/bold]")
    console.print("  Agent: StatigentDataScienceAgent")
    console.print(f"  Agent model: {model}")
    console.print(f"  Judge model: {judge_model}")
    console.print(f"  Limit: {limit or 'all'}")
    console.print(f"  Task ID: {task_id or 'all'}")
    console.print(f"  Output: {output_dir}")
    console.print(f"  Registry: {path or 'bundled defaults'}")

    adapter = DSBenchAdapter(
        task="data_analysis",
        judge_model_name=judge_model,
    )
    agent = StatigentDataScienceAgent(model_name=model)

    console.print("\n[blue]Preparing DSBench data analysis data...[/blue]")
    adapter.prepare()
    total_samples = len(adapter._samples)
    total_questions = sum(
        len(sample.get("questions", [])) for sample in adapter._samples
    )
    console.print(f"  {total_samples} samples ({total_questions} questions) available")

    console.print("\n[blue]Running evaluation...[/blue]")
    kwargs: dict[str, object] = {"output_dir": str(output_dir)}
    if limit is not None:
        kwargs["limit"] = limit
    if task_id is not None:
        kwargs["task_id"] = task_id

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

    total = result.details.get("total", "?")
    console.print(f"\n[bold green]Done - evaluated {total} questions[/bold green]")


def _resolve_registry_path(registry_path: Path | None, console: Console) -> str | None:
    if registry_path is not None:
        if registry_path.exists():
            return str(registry_path)
        console.print(
            f"[yellow]Registry file not found: {registry_path}, "
            "falling back to bundled defaults[/yellow]"
        )
        return None
    if _DEFAULT_REGISTRY_PATH.exists():
        return str(_DEFAULT_REGISTRY_PATH)
    return None


if __name__ == "__main__":
    typer.run(main)
