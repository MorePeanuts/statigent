# Benchmark Adapter Layer Design

## Overview

Create a `statigent.benchmarks` subpackage that provides a unified evaluation interface for three data science benchmarks (DABench, DSBench, MLE-Bench). The adapter layer handles input formatting, agent execution, and evaluation scoring, with all LLM calls routed through `statigent.models`.

## Package Structure

```
src/statigent/benchmarks/
├── __init__.py          # Public API: run_benchmark, list_benchmarks
├── base.py              # BenchmarkAdapter ABC, Evaluator ABC, EvalResult
├── evaluators.py        # LLMJudgeEvaluator, ExactMatchEvaluator, MetricEvaluator, ReformatEvaluator
├── dabench.py           # DABenchAdapter
├── dsbench.py           # DSBenchAdapter (DA + DM via task parameter)
└── mlebench.py          # MLEBenchAdapter
```

## Core Abstractions

### ScoreResult & EvalResult

```python
@dataclass
class ScoreResult:
    score: float
    details: dict[str, Any]    # benchmark-specific metrics (per-question scores, breakdowns)

@dataclass
class EvalResult:
    score: float
    details: dict[str, Any]    # benchmark-specific metrics (per-question scores, breakdowns)
    agent_name: str            # which agent was evaluated
    model_name: str            # which model the agent used
    benchmark_name: str        # which benchmark was run
```

`Evaluator` returns `ScoreResult` (score + details only). `BenchmarkAdapter.evaluate()` wraps it into `EvalResult` by adding agent/model/benchmark context.

### Evaluator (ABC)

```python
class Evaluator(ABC):
    @abstractmethod
    def evaluate(self, predictions: Any, references: Any) -> ScoreResult: ...
```

Implementations:
- **ExactMatchEvaluator** — String exact match + float tolerance (1e-6). Used by DABench.
- **LLMJudgeEvaluator** — Uses `statigent.models.get_model()` to obtain a langchain `BaseChatModel`, invokes it as a judge. Used by DSBench Data Analysis.
- **MetricEvaluator** — Computes ML metrics (accuracy, AUC, RMSE, etc.) via per-competition evaluation functions. Used by DSBench Data Modeling and MLE-Bench.
- **ReformatEvaluator** — Post-processor that uses `statigent.models.get_model()` to reformat agent responses into required structured format. Used by DABench (optional step before scoring).

### BenchmarkAdapter (ABC)

```python
class BenchmarkAdapter(ABC):
    name: str

    @abstractmethod
    def prepare(self) -> None:
        """Download/verify benchmark data."""

    @abstractmethod
    def run(self, agent: DataScienceAgent, **kwargs: Any) -> Any:
        """Run agent on benchmark tasks, return raw predictions."""

    @abstractmethod
    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score predictions against ground truth."""

    def execute(self, agent: DataScienceAgent, **kwargs: Any) -> EvalResult:
        """Full pipeline: prepare -> run -> evaluate."""
        self.prepare()
        predictions = self.run(agent, **kwargs)
        return self.evaluate(predictions, **kwargs)
```

### DataScienceAgent Protocol

```python
class DataScienceAgent(Protocol):
    name: str
    model_name: str

    def run_analysis_for_eval(self, prompt: str, *, files: list[Path] | None = None) -> str:
        """Run agent on an analysis task, return text response."""
        ...

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
    ) -> Path:
        """Run agent on a modeling task, return path to prediction CSV."""
        ...
```

## Evaluation Output

All evaluation results are stored under:

```
evaluations/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/
├── meta.json                    # agent_name, model_name, benchmark_name, timestamp, config
├── process/                     # agent generation process (written by agent implementation)
│   ├── 0.jsonl                  # per-task interaction trace (tool calls, thoughts, etc.)
│   ├── 1.jsonl
│   └── ...
├── predictions/                 # agent raw output
│   ├── responses.jsonl          # for DABench / DSBench-DA
│   └── ...                      # or submission CSVs for DSBench-DM / MLE-Bench
└── evaluation/                  # evaluation results
    ├── scores.json              # EvalResult + breakdown metrics
    └── details/                 # per-task evaluation details
```

## Benchmark-Specific Designs

### DABenchAdapter

- **Data**: Already in repo at `benchmarks/InfiAgent-DABench/examples/DA-Agent/data/` (questions, labels, CSV tables). No download needed.
- **prepare()**: Verify data files exist.
- **run(agent)**: Iterate over questions from `da-dev-questions.jsonl`. For each question, construct prompt (question text + constraints + format + CSV path), call `agent.run_analysis_for_eval()`. Collect `{"id": int, "response": str}`.
- **evaluate(predictions)**: Optionally apply `ReformatEvaluator` (using `statigent.models` model) to clean responses into `@answer_name[answer]` format, then score with `ExactMatchEvaluator` against `da-dev-labels.jsonl`.
- **LLM usage**: ReformatEvaluator uses `statigent.models.get_model()` instead of hardcoded OpenAI/gpt-3.5-turbo-16k.
- **Metrics**: ABQ (all sub-answers correct), PSAQ (proportional sub-answer score), UASQ (independent sub-answer score), plus breakdown by concept and difficulty.

### DSBenchAdapter

- **Data**: Download from HuggingFace/Google Drive, extract to `benchmarks/data/DSBench/`. Added to `.gitignore`.
- **prepare()**: Verify or download data for the specified task.
- **run(agent, task="data_analysis"|"data_modeling")**:
  - **data_analysis**: Read `data_analysis/data.json`, for each challenge read introduction + Excel content + question text, call `agent.run_analysis_for_eval()`. Output: `{"id": str, "response": str}`.
  - **data_modeling**: Read `data_modeling/data.json`, for each competition read task description + provide CSV paths, call `agent.run_modeling_for_eval()`. Output: prediction CSV paths.
- **evaluate(predictions)**:
  - **data_analysis**: `LLMJudgeEvaluator` — rewritten `compute_answer.py` logic using `statigent.models.get_model()` instead of hardcoded OpenAI/gpt-4o-2024-05-13.
  - **data_modeling**: `MetricEvaluator` — calls per-competition eval scripts (e.g., `titanic_eval.py` with sklearn metrics).
- **Metrics**: DA = accuracy; DM = normalized performance score `max(0, (pred - baseline) / (ground_truth - baseline))` + task completion rate.

### MLEBenchAdapter

- **Data**: Download via `mlebench prepare` CLI (Kaggle API). Store to `benchmarks/data/MLE-Bench/`. Added to `.gitignore`.
- **prepare()**: Call `mlebench prepare --lite` (or verify existing data).
- **run(agent)**: For each competition, read `description.md` + public data paths, call `agent.run_modeling_for_eval()`. Output: `submission.csv` paths.
- **evaluate(predictions)**: `MetricEvaluator` — calls `mlebench grade-sample` for each submission.
- **detect_violations(logs)**: Optional extension method. Rewrites `rule_violation_detector` using `statigent.models.get_model()` instead of hardcoded gpt-4o-mini.
- **Metrics**: Per-competition scores + Kaggle-style medal placement (gold/silver/bronze). Core metric: `any_medal_percentage`.

## LLM-as-Judge Rewrite

All LLM usage in evaluation is rewritten to use `statigent.models`:

| Scenario | Original | Rewrite |
|----------|----------|---------|
| DABench reformat | `openai.ChatCompletion` + `gpt-3.5-turbo-16k` | `statigent.models.get_model()` + langchain `BaseChatModel.invoke()` |
| DSBench DA judge | `openai.ChatCompletion` + `gpt-4o-2024-05-13` | `statigent.models.get_model()` + langchain `BaseChatModel.invoke()` |
| MLE-Bench violation | `openai_chat_completion_with_retries` + `gpt-4o-mini` | `statigent.models.get_model()` + langchain `BaseChatModel.invoke()` |

The model used for judging is configurable via a `judge_model_name` parameter (defaulting to a model from the registry).

## Baseline Agent

Located at `baseline/react/`:

```python
# baseline/react/agent.py
from pathlib import Path
from langchain.agents import create_agent
from statigent.models import get_model

class ReactBaselineAgent:
    name: str = "react-baseline"

    def __init__(self, model_name: str = "deepseek-v4-flash"):
        self.model_name = model_name
        llm = get_model(model_name)
        tools = [self._python_repl, self._read_file]
        self.agent = create_agent(llm, tools, system_prompt=SYSTEM_PROMPT)

    def run_analysis_for_eval(self, prompt: str, *, files: list[Path] | None = None) -> str: ...
    def run_modeling_for_eval(self, prompt: str, *, train_path: Path, test_path: Path, sample_submission_path: Path) -> Path: ...
```

- **Tools**: Python REPL (process-level execution, `PythonREPLTool`) + file reading
- **Agent creation**: Uses `langchain.agents.create_agent` (current API, not deprecated `create_react_agent`)
- **System prompt**: Instructs the agent to analyze data using Python code and return answers in the required format

## Minimal Validation

Run baseline agent on DABench with 3-5 questions to verify the full `prepare -> run -> evaluate` pipeline works end-to-end. This is not a full benchmark run — it validates the adapter layer is correctly wired.

## Data Management

- `benchmarks/data/` added to `.gitignore` (large datasets should not be committed)
- DABench data stays in the existing submodule location
- DSBench and MLE-Bench data go to `benchmarks/data/DSBench/` and `benchmarks/data/MLE-Bench/`
- Data download is handled by `prepare()` methods or separate CLI commands
