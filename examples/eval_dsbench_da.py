"""Evaluate StatigentDataScienceAgent on DSBench data analysis tasks."""

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from statigent.agents import StatigentDataScienceAgent
from statigent.benchmarks.base import BenchmarkAdapter, RunPersister
from statigent.benchmarks.dsbench import DSBenchAdapter
from statigent.benchmarks.reporting import build_evaluation_table, find_latest_run_dir
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

    if resume_dir is not None:
        import json

        meta = json.loads((resume_dir / "meta.json").read_text())
        model = meta.get("model_name", model)
        console.print(f"[dim]Resuming — using model '{model}' from meta.json[/dim]")

    path = _resolve_registry_path(registry_path, console)
    registry = load_registry(path)
    if not registry.has_model(model):
        available = ", ".join(registry.list_models())
        console.print(f"[red]Unknown model: {model}. Available: {available}[/red]")
        raise typer.Exit(code=1)
    if not registry.has_model(judge_model):
        available = ", ".join(registry.list_models())
        console.print(
            f"[red]Unknown judge model: {judge_model}. "
            f"Available: {available}[/red]"
        )
        raise typer.Exit(code=1)

    console.print("[bold]DSBench Data Analysis Evaluation[/bold]")
    console.print("  Agent: StatigentDataScienceAgent")
    console.print(f"  Agent model: {model}")
    console.print(f"  Judge model: {judge_model}")
    console.print(f"  Limit: {limit or 'all'}")
    console.print(f"  Task ID: {task_id or 'all'}")
    console.print(f"  Resume dir: {resume_dir or 'N/A'}")
    console.print(f"  Skip: {skip or 'none'}")
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

    if resume_dir is not None:
        _resume_run(adapter, agent, resume_dir, limit, task_id, judge_model, console)
    else:
        kwargs: dict[str, object] = {"output_dir": str(output_dir), "skip": skip}
        if limit is not None:
            kwargs["limit"] = limit
        if task_id is not None:
            kwargs["task_id"] = task_id

        result = adapter.execute(agent, **kwargs)
        run_dir = find_latest_run_dir(output_dir, result)
        console.print(build_evaluation_table(run_dir, result=result))

        total = result.total_tasks
        console.print(f"\n[bold green]Done - evaluated {total} questions[/bold green]")


def _resume_run(
    adapter: DSBenchAdapter,
    agent: StatigentDataScienceAgent,
    resume_dir: Path,
    limit: int | None,
    task_id: str | None,
    judge_model: str,
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
    console.print(build_evaluation_table(resume_dir, result=result))

    total = result.total_tasks
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
