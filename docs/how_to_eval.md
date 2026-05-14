# How to Evaluate Your Agent

This guide explains how to use the statigent benchmark evaluation layer to evaluate data science agents.

## Quick Start

```python
import sys
from pathlib import Path

# baseline/react/ contains standalone scripts, not a package
sys.path.insert(0, str(Path("baseline/react").resolve()))

from statigent.benchmarks import run_benchmark, get_benchmark, list_benchmarks
from agent import ReactBaselineAgent

# List available benchmarks
print(list_benchmarks())
# ['dabench', 'dsbench-da', 'dsbench-dm', 'mlebench']

# Run a full evaluation pipeline
agent = ReactBaselineAgent(model_name="deepseek-v4-flash")
result = run_benchmark("dabench", agent)
print(f"Score: {result.score}, Agent: {result.agent_name}, Model: {result.model_name}")
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

## Benchmark Details

### DABench — Closed-Form Data Analysis

257 questions across 68 CSV datasets. Agent answers must follow `@answer_name[value]` format.

```python
from statigent.benchmarks.dabench import DABenchAdapter

adapter = DABenchAdapter()
adapter.prepare()

# Run with limit for testing
predictions = adapter.run(agent, limit=5)

# Full evaluation
result = adapter.evaluate(predictions, agent_name=agent.name, model_name=agent.model_name)
print(f"ABQ: {result.details['abq']}")   # All sub-answers correct
print(f"PSAQ: {result.details['psaq']}") # Proportional sub-answer score
print(f"UASQ: {result.details['uasq']}") # Independent sub-answer score
```

**With reformat** (if agent doesn't output `@name[value]` format):

```python
adapter = DABenchAdapter(reformat=True, reformat_model="deepseek-v4-flash")
```

### DSBench — Data Analysis & Modeling

Two sub-tasks, accessed separately:

```python
from statigent.benchmarks.dsbench import DSBenchAdapter

# Data Analysis (LLM-judged)
da_adapter = DSBenchAdapter(task="data_analysis", judge_model_name="deepseek-v4-flash")
da_adapter.prepare()
result = da_adapter.execute(agent)

# Data Modeling (metric-based, not yet fully implemented in adapter)
dm_adapter = DSBenchAdapter(task="data_modeling")
dm_adapter.prepare()
```

### MLE-Bench — ML Engineering

75 Kaggle competitions, Kaggle-style medal evaluation.

```python
from statigent.benchmarks.mlebench import MLEBenchAdapter

# Lite mode (22 competitions)
adapter = MLEBenchAdapter(lite=True)
adapter.prepare()  # Downloads data if needed
result = adapter.execute(agent)

# Full mode (75 competitions)
adapter = MLEBenchAdapter(lite=False)

# Violation detection (optional)
violations = adapter.detect_violations(submission_dir, output_dir)
```

## Implementing Your Own Agent

Your agent must satisfy the `DataScienceAgent` protocol:

```python
from pathlib import Path
from statigent.benchmarks.base import DataScienceAgent

class MyAgent:
    name: str = "my-agent"
    model_name: str = "my-model"

    def run_analysis_for_eval(self, prompt: str, *, files: list[Path] | None = None) -> str:
        """Run on an analysis task. Return text response."""
        # Your implementation here
        return "answer"

    def run_modeling_for_eval(
        self, prompt: str, *,
        train_path: Path, test_path: Path, sample_submission_path: Path,
    ) -> Path:
        """Run on a modeling task. Return path to prediction CSV."""
        # Your implementation here
        return Path("submission.csv")
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
| DSBench DM | Normalized score | max(0, (pred - baseline) / (gt - baseline)) |
| MLE-Bench | Medal percentage | Kaggle-style gold/silver/bronze |
