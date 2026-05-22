"""Evaluate predictions from an existing run directory.

Reads ``meta.json`` to detect the benchmark type, loads predictions from
``predictions/responses.jsonl``, runs the corresponding adapter's
``evaluate()`` method, and writes results to ``evaluation/scores.json``.

Usage:
    uv run python tools/calc_evaluation.py evaluations/dabench-xxx
    uv run python tools/calc_evaluation.py \
        evaluations/dsbench-da-xxx --model deepseek-v4-flash
"""

import json
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console
from rich.table import Table

from statigent.benchmarks.base import BenchmarkAdapter, EvalResult, RunPersister

_DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "models.toml"
)

# Benchmarks that require a judge model (and thus registry validation).
_JUDGE_BENCHMARKS = {"dsbench-da"}


def _build_adapter(
    benchmark_name: str,
    model: str,
    registry_path: str | None,
    console: Console,
) -> BenchmarkAdapter:
    """Instantiate the correct adapter based on benchmark_name from meta.json."""
    if benchmark_name in _JUDGE_BENCHMARKS:
        from statigent.models import load_registry

        resolved = _resolve_registry_path(registry_path, console)
        registry = load_registry(resolved)
        if not registry.has_model(model):
            available = ", ".join(registry.list_models())
            console.print(f"[red]Unknown model: {model}. Available: {available}[/red]")
            raise typer.Exit(code=1)

    if benchmark_name == "dabench":
        from statigent.benchmarks.dabench import DABenchAdapter

        return DABenchAdapter()
    if benchmark_name == "dsbench-da":
        from statigent.benchmarks.dsbench import DSBenchAdapter

        return DSBenchAdapter(task="data_analysis", judge_model_name=model)
    if benchmark_name == "dsbench-dm":
        from statigent.benchmarks.dsbench import DSBenchAdapter

        return DSBenchAdapter(task="data_modeling")
    if benchmark_name == "mlebench":
        from statigent.benchmarks.mlebench import MLEBenchAdapter

        return MLEBenchAdapter()
    raise typer.BadParameter(f"Unknown benchmark_name '{benchmark_name}' in meta.json")


def main(
    run_dir: Annotated[
        Path,
        typer.Argument(
            help=(
                "Path to a run output directory containing meta.json and predictions/."
            ),
            exists=True,
            dir_okay=True,
            file_okay=False,
        ),
    ],
    model: Annotated[
        str,
        typer.Option(help="Model profile name (used for judge and registry lookup)."),
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
    """Evaluate predictions from an existing run directory."""
    console = Console()

    meta_path = run_dir / "meta.json"
    if not meta_path.exists():
        console.print(f"[red]meta.json not found in {run_dir}[/red]")
        raise typer.Exit(code=1)

    meta: dict[str, Any] = json.loads(meta_path.read_text())
    benchmark_name = meta.get("benchmark_name", "")
    agent_name = meta.get("agent_name", "unknown")
    model_name = meta.get("model_name", "unknown")

    if not benchmark_name:
        console.print("[red]meta.json missing 'benchmark_name'[/red]")
        raise typer.Exit(code=1)

    console.print("[bold]Calculating Evaluation[/bold]")
    console.print(f"  Run dir: {run_dir}")
    console.print(f"  Benchmark: {benchmark_name}")
    console.print(f"  Agent: {agent_name}")
    console.print(f"  Model: {model_name}")

    adapter = _build_adapter(
        benchmark_name, model, _resolve_registry_path(registry_path, console), console
    )
    adapter.prepare()

    predictions = BenchmarkAdapter.load_predictions(run_dir)
    if not predictions:
        console.print("[red]No predictions found in predictions/responses.jsonl[/red]")
        raise typer.Exit(code=1)

    console.print(f"  Loaded {len(predictions)} predictions")
    console.print("\n[blue]Evaluating predictions...[/blue]")

    result = adapter.evaluate(
        predictions,
        agent_name=agent_name,
        model_name=model_name,
    )

    persister = RunPersister.open(run_dir)
    persister.finalize(result)

    _print_results(result, benchmark_name, console)

    console.print(
        f"\n[bold green]Done — results written to "
        f"{run_dir}/evaluation/scores.json[/bold green]"
    )


def _print_results(result: EvalResult, benchmark_name: str, console: Console) -> None:
    """Display evaluation results in a table."""
    table = Table(title="Evaluation Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")

    if benchmark_name == "dabench":
        table.add_row("ABQ", f"{result.details.get('abq', 'N/A')}")
        table.add_row("PSAQ", f"{result.details.get('psaq', 'N/A')}")
        table.add_row("UASQ", f"{result.details.get('uasq', 'N/A')}")
        table.add_row("Score", f"{result.score:.4f}")
    elif benchmark_name == "dsbench-da":
        table.add_row("Accuracy", f"{result.score:.4f}")
        table.add_row(
            "Avg Challenge Acc",
            f"{result.details.get('avg_challenge_accuracy', 'N/A')}",
        )
    elif benchmark_name == "dsbench-dm":
        table.add_row("Normalized Score", f"{result.score:.4f}")
        table.add_row(
            "Task Completion",
            f"{result.details.get('task_completion_rate', 'N/A')}",
        )
    elif benchmark_name == "mlebench":
        table.add_row("Score", f"{result.score:.4f}")

    table.add_row("Agent", result.agent_name)
    table.add_row("Model", result.model_name)
    console.print(table)


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
