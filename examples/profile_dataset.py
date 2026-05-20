"""Profile a dataset with InputProfiler to inspect what the agent sees.

Supports both built-in benchmarks (mirroring adapter file-collection logic)
and arbitrary local paths.

Usage:
    uv run python examples/profile_dataset.py dabench 0
    uv run python examples/profile_dataset.py dsbench_da 00000001
    uv run python examples/profile_dataset.py dsbench_dm titanic
    uv run python examples/profile_dataset.py /path/to/custom/dataset
"""

import json
import tempfile
from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel
from rich.pretty import Pretty
from rich.table import Table

from statigent.input.profiler import InputProfiler
from statigent.schemas import DatasetProfile

REPO_ROOT = Path(__file__).resolve().parent.parent
console = Console()
app = typer.Typer(
    help="Profile a dataset with InputProfiler.",
    no_args_is_help=True,
)

_DSBENCH_DIR = REPO_ROOT / "benchmarks" / "data" / "DSBench"
_DABENCH_DIR = (
    REPO_ROOT / "benchmarks" / "InfiAgent-DABench" / "examples" / "DA-Agent" / "data"
)

BENCHMARK_NAMES = ("dabench", "dsbench_da", "dsbench_dm")


# ---------------------------------------------------------------------------
# File collectors — each mirrors the corresponding adapter exactly
# ---------------------------------------------------------------------------

def _collect_dsbench_da(sample_id: str) -> list[Path]:
    data_base = _DSBENCH_DIR / "data_analysis" / "data" / sample_id
    if not data_base.exists():
        console.print(f"[red]Not found: {data_base}")
        raise typer.Exit(1)
    return [
        f
        for f in sorted(data_base.iterdir())
        if f.is_file() and f.suffix != ".txt" and f.name != ".DS_Store"
    ]


def _collect_dsbench_dm(sample_name: str) -> list[Path]:
    resplit = _DSBENCH_DIR / "data_modeling" / "data" / "data_resplit" / sample_name
    if not resplit.exists():
        console.print(f"[red]Not found: {resplit}")
        raise typer.Exit(1)
    return [
        f
        for f in (
            resplit / "train.csv",
            resplit / "test.csv",
            resplit / "sample_submission.csv",
        )
        if f.exists()
    ]


def _collect_dabench(question_id: str) -> list[Path]:
    questions_path = _DABENCH_DIR / "da-dev-questions.jsonl"
    if not questions_path.exists():
        console.print(f"[red]DABench data not found: {_DABENCH_DIR}")
        raise typer.Exit(1)
    with open(questions_path) as f:
        questions = [json.loads(line) for line in f if line.strip()]
    matches = [q for q in questions if str(q["id"]) == question_id]
    if not matches:
        max_id = len(questions) - 1
        console.print(
            f"[red]Question id '{question_id}' not found (0-{max_id})"
        )
        raise typer.Exit(1)
    csv_path = _DABENCH_DIR / "da-dev-tables" / matches[0]["file_name"]
    if not csv_path.exists():
        console.print(f"[red]CSV not found: {csv_path}")
        raise typer.Exit(1)
    return [csv_path]


def _collect_path(dataset_path: Path) -> list[Path]:
    if not dataset_path.exists():
        console.print(f"[red]Not found: {dataset_path}")
        raise typer.Exit(1)
    if dataset_path.is_file():
        return [dataset_path]
    return [
        f
        for f in sorted(dataset_path.rglob("*"))
        if f.is_file() and f.name != ".DS_Store"
    ]


def collect_files(target: str, task_id: str | None) -> list[Path]:
    match target:
        case "dabench":
            return _collect_dabench(task_id or "0")
        case "dsbench_da":
            return _collect_dsbench_da(task_id or "00000001")
        case "dsbench_dm":
            if not task_id:
                _print_dsbench_dm_samples()
                raise typer.Exit(1)
            return _collect_dsbench_dm(task_id)
        case _:
            return _collect_path(Path(target))


# ---------------------------------------------------------------------------
# Sample listing (only when task_id is missing for benchmarks that need it)
# ---------------------------------------------------------------------------

def _print_dsbench_dm_samples() -> None:
    resplit = _DSBENCH_DIR / "data_modeling" / "data" / "data_resplit"
    if not resplit.exists():
        console.print("[red]DSBench DM data not found")
        return
    names = sorted(p.name for p in resplit.iterdir() if p.is_dir())
    console.print("[bold]Available DSBench DM samples:")
    for n in names:
        console.print(f"  {n}")


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _human_bytes(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def _print_profile(profile: DatasetProfile) -> None:
    console.rule("[bold blue]DatasetProfile")
    console.print(Pretty(profile, max_depth=2))

    file_table = Table(title="Discovered Files", show_lines=False)
    file_table.add_column("Relative Path", style="cyan")
    file_table.add_column("Suffix", justify="center")
    file_table.add_column("Size", justify="right")
    file_table.add_column("Tabular?", justify="center")
    for f in profile.files:
        file_table.add_row(
            f.relative_path, f.suffix, _human_bytes(f.size_bytes),
            "Yes" if f.is_tabular else "No",
        )
    console.print(file_table)

    for t in profile.tables:
        console.print(
            Panel(
                f"[bold]{t.relative_path}[/bold]\n"
                f"Rows: {t.rows}  |  Columns: {t.columns}\n"
                f"Columns: {', '.join(t.column_names)}\n"
                f"Dtypes: {t.dtypes}\n"
                f"Missing rates: {t.missing_rates}\n"
                f"Unique counts: {t.unique_counts}\n"
                f"Likely time columns: {t.likely_time_columns}\n"
                f"Likely categorical columns: {t.likely_categorical_columns}\n"
                f"Numeric summaries: {t.numeric_summaries}\n"
                f"Sample rows (first {len(t.sample_rows)}):",
                title=f"TableProfile: {t.relative_path}",
            )
        )
        for i, row in enumerate(t.sample_rows, 1):
            console.print(f"  Row {i}: {row}")

    if profile.warnings:
        console.print("\n[bold yellow]Warnings:")
        for w in profile.warnings:
            console.print(f"  - {w}")

    console.print(
        Panel(
            profile.compact_summary(),
            title="Compact Summary (for LLM context)",
            border_style="green",
        )
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@app.command()
def main(
    target: str = typer.Argument(
        ...,
        help=(
            f"Benchmark name ({', '.join(BENCHMARK_NAMES)})"
            " or path to a custom dataset."
        ),
    ),
    task_id: str | None = typer.Argument(
        None,
        help="Task/sample id for benchmarks. "
             "DABench: question id (e.g. 0); "
             "DSBench-DA: sample id (e.g. 00000001); "
             "DSBench-DM: sample name (e.g. titanic). "
             "Ignored for custom paths.",
    ),
) -> None:
    """Profile a dataset with InputProfiler to inspect what the agent sees at runtime.

    For built-in benchmarks, file collection mirrors the adapter logic so the
    profiled files match exactly what the agent receives during evaluation.
    For custom paths, all files under the directory are scanned recursively.
    """
    if target in BENCHMARK_NAMES and target != "dsbench_dm" and task_id is None:
        defaults = {"dabench": "0", "dsbench_da": "00000001"}
        task_id = defaults[target]

    data_files = collect_files(target, task_id)
    if not data_files:
        console.print("[yellow]No data files found.")
        return

    label = f"{target} / {task_id}" if task_id else target
    console.print(f"[bold]Profiling:[/bold] {label}")
    console.print(f"  Files: {[f.name for f in data_files]}")

    with tempfile.TemporaryDirectory(prefix="statigent-profile-") as tmp:
        profiler = InputProfiler(work_dir=Path(tmp))
        profile = profiler.profile_paths(data_files)

    _print_profile(profile)
    console.print(
        f"\n[green]Done. {len(profile.files)} files, "
        f"{len(profile.tables)} tables profiled."
    )


if __name__ == "__main__":
    app()
