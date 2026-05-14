"""Benchmark evaluation adapters for data science agents."""

from __future__ import annotations

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    DataScienceAgent,
    EvalResult,
    Evaluator,
    ScoreResult,
)
from statigent.benchmarks.dabench import DABenchAdapter
from statigent.benchmarks.dsbench import DSBenchAdapter
from statigent.benchmarks.mlebench import MLEBenchAdapter

_REGISTRY: dict[str, type[BenchmarkAdapter]] = {
    "dabench": DABenchAdapter,
    "mlebench": MLEBenchAdapter,
}


def list_benchmarks() -> list[str]:
    """List available benchmark names."""
    return list(_REGISTRY.keys())


def get_benchmark(name: str, **kwargs: object) -> BenchmarkAdapter:
    """Get a benchmark adapter by name."""
    # DSBench requires task parameter — construct directly
    if name == "dsbench-da":
        return DSBenchAdapter(task="data_analysis", **kwargs)  # type: ignore[arg-type]
    if name == "dsbench-dm":
        return DSBenchAdapter(task="data_modeling", **kwargs)  # type: ignore[arg-type]

    if name not in _REGISTRY:
        available = ", ".join([*_REGISTRY.keys(), "dsbench-da", "dsbench-dm"])
        raise ValueError(f"Unknown benchmark '{name}'. Available: {available}")
    factory = _REGISTRY[name]
    return factory(**kwargs)


def run_benchmark(
    name: str,
    agent: DataScienceAgent,
    **kwargs: object,
) -> EvalResult:
    """Run a full benchmark evaluation pipeline."""
    adapter = get_benchmark(name, **kwargs)
    return adapter.execute(agent)


__all__ = [
    "BenchmarkAdapter",
    "DABenchAdapter",
    "DSBenchAdapter",
    "DataScienceAgent",
    "EvalResult",
    "Evaluator",
    "MLEBenchAdapter",
    "ScoreResult",
    "get_benchmark",
    "list_benchmarks",
    "run_benchmark",
]
