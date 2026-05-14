# How to Evaluate Your Agent

This guide explains how to use the statigent benchmark evaluation layer to evaluate data science agents.

## Quick Start

```python
from statigent.benchmarks import run_benchmark, get_benchmark, list_benchmarks
from statigent.baseline import ReactBaselineAgent

# List available benchmarks
print(list_benchmarks())
# ['dabench', 'dsbench-da', 'dsbench-dm', 'mlebench']

# Run a full evaluation pipeline
agent = ReactBaselineAgent(model_name="deepseek-v4-flash")
result = run_benchmark("dabench", agent)
print(f"Score: {result.score}, Agent: {result.agent_name}, Model: {result.model_name}")

# With output persistence
result = run_benchmark("dabench", agent, output_dir="evaluations")
```

## Prerequisites

### Environment Variables

- `DEEPSEEK_API_KEY`: Required for model access (set in `.env` or environment)

### Data Preparation

Each benchmark has different data requirements:

| Benchmark | Data Location | Preparation |
|-----------|--------------|-------------|
| DABench | `benchmarks/InfiAgent-DABench/examples/DA-Agent/data/` | Already in repo (git submodule) |
| DSBench | `benchmarks/data/DSBench/` | Download required (see below) |
| MLE-Bench | `benchmarks/data/MLE-Bench/` | Download required (see below) |

#### DSBench Data Download

```bash
# Data Analysis data
cd benchmarks/data
mkdir -p DSBench
# Download from HuggingFace:
# https://huggingface.co/datasets/liqiang888/DSBench/blob/main/data_analysis/data.zip
# Extract to benchmarks/data/DSBench/data_analysis/

# Data Modeling data
# Download from HuggingFace:
# https://huggingface.co/datasets/liqiang888/DSBench/blob/main/data_modeling/data.zip
# Extract to benchmarks/data/DSBench/data_modeling/
```

#### MLE-Bench Data Download

```bash
# Install mlebench package
pip install -e benchmarks/MLE-Bench/

# Configure Kaggle API (place kaggle.json in ~/.kaggle/)

# Download Lite subset (22 competitions, recommended for testing)
mlebench prepare --lite --data-dir benchmarks/data/MLE-Bench/

# Or download all 75 competitions
mlebench prepare --all --data-dir benchmarks/data/MLE-Bench/
```

## Core Concepts

### DataScienceAgent Protocol

All agents must satisfy the `DataScienceAgent` protocol:

```python
from pathlib import Path
from statigent.benchmarks.base import DataScienceAgent, AgentTrace

class MyAgent:
    name: str = "my-agent"
    model_name: str = "my-model"

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        """Run on an analysis task. Return text response and execution trace."""
        # Your implementation here
        return "answer", [{"role": "assistant", "content": "answer"}]

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
    ) -> tuple[Path, AgentTrace]:
        """Run on a modeling task. Return path to prediction CSV and execution trace."""
        # Your implementation here
        return Path("submission.csv"), [{"role": "assistant", "content": "done"}]
```

Key points:
- Both methods return a **tuple** of (result, trace) where trace is an `AgentTrace` (i.e., `list[dict[str, Any]]`)
- `task_instructions` is provided by the benchmark adapter and contains formatting/constraint rules (e.g., output format for DABench)

### Evaluation Pipeline

The recommended way is `adapter.execute(agent)`, which runs the full pipeline:

```
prepare → run → evaluate → persist (optional)
```

- `prepare()`: Verify/download benchmark data
- `run(agent)`: Run agent on all tasks, returns `BenchmarkRunResult` (predictions + traces)
- `evaluate(predictions)`: Score predictions against ground truth, returns `EvalResult`
- `persist(result, predictions, traces)`: Save results to disk (only if `output_dir` is provided)

You can also call each step individually for more control.

### EvalResult

The final evaluation result includes:

```python
@dataclass
class EvalResult:
    score: float           # Primary metric score
    details: dict[str, Any]  # Per-question details, sub-metrics, etc.
    agent_name: str
    model_name: str
    benchmark_name: str    # e.g., "dabench", "dsbench-da", "mlebench"
```

### Result Persistence

When `output_dir` is passed to `execute()`, results are saved to:

```
{output_dir}/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/
├── meta.json
├── predictions/
│   └── responses.jsonl
├── traces/
│   ├── {question_id}.jsonl
│   └── ...
└── evaluation/
    └── scores.json
```

Defaults to `./evaluations/` if `base_dir` is not specified.

## Benchmark Details

### DABench — Closed-Form Data Analysis

257 questions across 68 CSV datasets. Agent answers must follow `@answer_name[value]` format.

```python
from statigent.benchmarks.dabench import DABenchAdapter

adapter = DABenchAdapter()
result = adapter.execute(agent)
print(f"ABQ: {result.details['abq']}")   # All sub-answers correct
print(f"PSAQ: {result.details['psaq']}") # Proportional sub-answer score
print(f"UASQ: {result.details['uasq']}") # Independent sub-answer score

# With limit for quick testing
result = adapter.execute(agent, limit=5)

# With output persistence
result = adapter.execute(agent, output_dir="evaluations")
```

**With reformat** (if agent doesn't output `@name[value]` format):

```python
adapter = DABenchAdapter(reformat=True, reformat_model="deepseek-v4-flash")
result = adapter.execute(agent)
```

**Step-by-step** (for more control):

```python
adapter = DABenchAdapter()
adapter.prepare()
run_result = adapter.run(agent, limit=5)
result = adapter.evaluate(run_result.predictions, agent_name=agent.name, model_name=agent.model_name)
```

### DSBench — Data Analysis & Modeling

Two sub-tasks, accessed separately via `get_benchmark()`:

```python
from statigent.benchmarks import get_benchmark

# Data Analysis (LLM-judged)
da_adapter = get_benchmark("dsbench-da", judge_model_name="deepseek-v4-flash")
result = da_adapter.execute(agent)

# Data Modeling (run works, but evaluate is not yet implemented)
dm_adapter = get_benchmark("dsbench-dm")
dm_adapter.prepare()
run_result = dm_adapter.run(agent)
# Evaluate manually — adapter.evaluate() raises StatigentBenchmarkError for DM tasks
```

**Note**: `list_benchmarks()` returns all four benchmark names including `dsbench-da` and `dsbench-dm`. You can also construct directly:

```python
from statigent.benchmarks.dsbench import DSBenchAdapter

da_adapter = DSBenchAdapter(task="data_analysis", judge_model_name="deepseek-v4-flash")
dm_adapter = DSBenchAdapter(task="data_modeling")
```

### MLE-Bench — ML Engineering

75 Kaggle competitions, Kaggle-style medal evaluation.

```python
from statigent.benchmarks.mlebench import MLEBenchAdapter

# Lite mode (22 competitions)
adapter = MLEBenchAdapter(lite=True)
result = adapter.execute(agent)

# Full mode (75 competitions)
adapter = MLEBenchAdapter(lite=False)
result = adapter.execute(agent)

# Skip data download if already prepared
adapter = MLEBenchAdapter(lite=True, skip_prepare=True)
result = adapter.execute(agent)
```

**Violation detection** (stub, not fully implemented):

```python
violations = adapter.detect_violations(submission_dir, output_dir, judge_model_name="deepseek-v4-flash")
```

## Running the Baseline

```bash
# Minimal DABench validation (3 questions)
uv run python baseline/react/run_dabench_mini.py
```

## Evaluation Metrics

| Benchmark | Primary Metric | Description |
|-----------|---------------|-------------|
| DABench | ABQ / PSAQ / UASQ | Exact match with float tolerance (1e-6) |
| DSBench DA | Accuracy | LLM-judged correctness |
| DSBench DM | Normalized score | Not yet implemented in adapter |
| MLE-Bench | Score percentage | Kaggle-style grading via `mlebench grade-sample` |
