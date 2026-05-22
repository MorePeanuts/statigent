"""Evaluate React baseline agent on DSBench data modeling tasks."""

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from statigent.baseline import ReactBaselineAgent
from statigent.benchmarks.base import BenchmarkAdapter, RunPersister
from statigent.benchmarks.dsbench import DSBenchAdapter
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
        typer.Option(help="Number of competitions to evaluate. Defaults to all."),
    ] = None,
    task_id: Annotated[
        str | None,
        typer.Option(
            help="Run a specific competition by name (e.g. titanic).",
        ),
    ] = None,
    resume_dir: Annotated[
        Path | None,
        typer.Option(
            help="Resume from a previous run's output directory. "
            "Skips tasks already completed and appends new results."
        ),
    ] = None,
    skip: Annotated[
        int,
        typer.Option(help="Skip the first N tasks. Ignored when --resume-dir is set."),
    ] = 0,
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

    console.print("[bold]DSBench Data Modeling Evaluation[/bold]")
    console.print(f"  Agent model: {model}")
    console.print(f"  Limit: {limit or 'all'}")
    console.print(f"  Task ID: {task_id or 'all'}")
    console.print(f"  Resume dir: {resume_dir or 'N/A'}")
    console.print(f"  Skip: {skip or 'none'}")
    console.print(f"  Output: {output_dir}")
    console.print(f"  Registry: {path or 'bundled defaults'}")

    adapter = DSBenchAdapter(task="data_modeling")
    agent = ReactBaselineAgent(model_name=model)

    console.print("\n[blue]Preparing DSBench data modeling data...[/blue]")
    adapter.prepare()
    total = len(adapter._samples)
    console.print(f"  {total} competitions available")

    if resume_dir is not None:
        _resume_run(adapter, agent, resume_dir, limit, task_id, console)
    else:
        kwargs: dict[str, object] = {"output_dir": str(output_dir), "skip": skip}
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


def _resume_run(
    adapter: DSBenchAdapter,
    agent: ReactBaselineAgent,
    resume_dir: Path,
    limit: int | None,
    task_id: str | None,
    console: Console,
) -> None:
    """Resume an interrupted run by loading existing predictions and continuing."""
    persister = RunPersister.open(resume_dir)
    old_predictions = BenchmarkAdapter.load_predictions(resume_dir)
    skip = len(old_predictions)
    console.print(f"  Resuming with {skip} existing predictions")

    console.print("\n[blue]Running agent on remaining tasks...[/blue]")
    run_kwargs: dict[str, object] = {"persister": persister, "skip": skip}
    if limit is not None:
        run_kwargs["limit"] = limit
    if task_id is not None:
        run_kwargs["task_id"] = task_id

    run_result = adapter.run(agent, **run_kwargs)
    console.print(f"  Generated {len(run_result.predictions)} new predictions")

    all_predictions = old_predictions + run_result.predictions
    console.print(f"\n[blue]Evaluating {len(all_predictions)} predictions...[/blue]")
    result = adapter.evaluate(
        all_predictions,
        agent_name=agent.name,
        model_name=agent.model_name,
    )

    persister.finalize(result)

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
