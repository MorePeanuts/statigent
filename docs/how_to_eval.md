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

75 Kaggle competitions, Kaggle-style medal evaluation. The agent runs inside a Docker container and must produce a `submission.csv` file.

#### Adapter Usage

```python
from statigent.benchmarks.mlebench import MLEBenchAdapter

# Lite mode (22 competitions)
adapter = MLEBenchAdapter(lite=True)
result = adapter.execute(agent)

# Full mode (75 competitions)
adapter = MLEBenchAdapter(lite=False)
result = adapter.execute(agent)

# Skip data download if already prepared — just don't call prepare()
adapter = MLEBenchAdapter(lite=True)
run_result = adapter.run(agent)
result = adapter.evaluate(run_result.predictions, agent_name=agent.name, model_name=agent.model_name)
```

**Violation detection** (stub, not fully implemented):

```python
violations = adapter.detect_violations(submission_dir, output_dir, judge_model_name="deepseek-v4-flash")
```

#### How Task Information Reaches the Agent

The agent runs in a Docker container. All information is passed via the filesystem:

| Host Path | Container Path | Access | Content |
|-----------|---------------|--------|---------|
| `competition/public_dir` | `/home/data/` | Read-only | Training data, task description, sample submission |
| `competition/private_dir` | `/private/` | Permission 700 (inaccessible) | Full test set with labels (grading only) |

Typical `/home/data/` layout (e.g., spaceship-titanic):

```
/home/data/
├── description.md          # Kaggle competition description (task, metric, fields)
├── train.csv               # Training set (with labels)
├── test.csv                # Test set (without label column)
└── sample_submission.csv   # Submission format reference
```

A generic instructions file at `/home/instructions.txt` provides benchmark-wide rules:
- Required output path: `/home/submission/submission.csv`
- Validation server at `http://localhost:5000/validate` (format check only, no score)
- Anti-cheating rules (no manual labeling, no copying others' solutions)
- Precedence: `instructions.txt` rules override `description.md`

The container also receives `COMPETITION_ID` as an environment variable.

#### Agent Execution Flow

```
Container starts (root)
  │
  ├─ 1. chmod a+rw /home (recursive, excluding /home/data)
  │     Grants nonroot user write access to /home/submission/, /home/logs/, /home/code/
  │
  ├─ 2. Start Flask grading server (background, localhost:5000)
  │     Provides /validate and /health endpoints
  │
  └─ 3. Main process stays alive until agent completes
       Agent runs via: bash /home/agent/start.sh [kwargs...]
```

Inside the container, the agent can:
- Read `/home/data/` for training data and task descriptions
- Write code to `/home/code/` and logs to `/home/logs/`
- Install additional Python packages (conda environment pre-installed)
- Call the validation server to check `submission.csv` format
- **Cannot** access `/private/` (correct answers are permission-blocked)

#### Data Preparation

Each competition has a `prepare.py` that re-splits the original Kaggle data. Since Kaggle does not publish test-set labels, MLE-Bench uses `train_test_split` on the original training data to create its own held-out test set:

```
Original Kaggle train.csv
        │
        ▼
  train_test_split(test_size=0.1, random_state=0)
        │
        ├── public/train.csv    (90% — visible to agent)
        └── private/test.csv    (10% — labels retained, used for grading)
```

The public test set (`public/test.csv`) is the same data with the target column dropped — this is what the agent must predict against.

#### Scoring & Medal Thresholds

Each competition has a `grade_fn(submission, answers)` that computes a raw float score. The raw score is then ranked against the real Kaggle leaderboard to determine medal tiers:

| Participants | Gold | Silver | Bronze |
|-------------|------|--------|--------|
| <100 | Top 10% | Top 20% | Top 40% |
| 100–249 | 10th place | Top 20% | Top 40% |
| 250–999 | 10+0.2% place | 50th place | 100th place |
| 1000+ | 10+0.2% place | Top 5% | Top 10% |

Medals are mutually exclusive (gold winners are not counted as silver/bronze).

The grading system automatically detects whether lower or higher scores are better by comparing the top and bottom entries on the real Kaggle leaderboard.

The final result per competition is a `CompetitionReport`:
```python
CompetitionReport:
    score: 0.81234
    gold_medal: False
    silver_medal: True
    bronze_medal: False
    above_median: True
    gold_threshold: 0.85000
    # ...
```

#### Complete Pipeline (Native MLE-Bench)

For reference, the native MLE-Bench pipeline (what the adapter wraps):

```
mlebench prepare -c <competition-id>    # Download & re-split data
        │
docker build agents/my-agent/           # Build agent image
        │
python run_agent.py                     # Run agent in container
        │                               #   → produces submission.csv
python experiments/make_submission.py   # Generate submission.jsonl
        │
mlebench grade --submission ...         # Score against private labels
        │
python experiments/aggregate.py         # Aggregate across seeds (mean ± SEM)
        │                               #   Core metric: any_medal_percentage
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
| MLE-Bench | Medal / Above-median | Raw score ranked against real Kaggle leaderboard → medal tier + above-median |
