# Benchmark Adapter Layer — Code Review Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three issues from code review: (1) restructure baseline/react from package to scripts, (2) separate agent system prompt from benchmark-specific prompt constraints, (3) implement evaluation output persistence per the spec.

**Architecture:** baseline/react becomes a flat script directory (no `__init__.py`). Agent system prompt only describes role/tools/style; each adapter injects benchmark-specific formatting via `task_instructions` in the user prompt. `EvalResult` gains a `save()` method and the adapter `execute()` method persists all outputs to `evaluations/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/`.

**Tech Stack:** Python 3.12+, dataclasses, json, datetime, pathlib

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Delete | `baseline/react/__init__.py` | Remove package marker |
| Modify | `baseline/react/agent.py` | Split system prompt; accept `task_instructions` param; change relative import to absolute |
| Modify | `baseline/react/tools.py` | No changes needed (standalone module) |
| Modify | `baseline/react/run_dabench_mini.py` | Update import path; pass `output_dir` to `execute()` |
| Modify | `src/statigent/benchmarks/base.py` | Add `save()` to `EvalResult`; update `DataScienceAgent` protocol; update `BenchmarkAdapter.execute()` |
| Modify | `src/statigent/benchmarks/dabench.py` | Build task-specific instruction block in `run()` prompt |
| Modify | `src/statigent/benchmarks/dsbench.py` | Build task-specific instruction block in `run()` prompt |
| Modify | `src/statigent/benchmarks/mlebench.py` | Build task-specific instruction block in `run()` prompt |
| Create | `src/statigent/benchmarks/persistence.py` | `save_eval_result()` function for writing evaluation output to disk |
| Modify | `tests/benchmarks/test_base.py` | Update tests for new `DataScienceAgent` protocol and `EvalResult.save()` |
| Create | `tests/benchmarks/test_persistence.py` | Tests for `save_eval_result()` |

---

### Task 1: Restructure baseline/react from package to scripts

**Files:**
- Delete: `baseline/react/__init__.py`
- Modify: `baseline/react/agent.py`
- Modify: `baseline/react/run_dabench_mini.py`

- [ ] **Step 1: Delete `baseline/react/__init__.py`**

```bash
rm baseline/react/__init__.py
rm -rf baseline/react/__pycache__
```

- [ ] **Step 2: Update `baseline/react/agent.py` — change relative import to absolute**

Change line 10 from:

```python
from .tools import python_repl, read_file
```

to:

```python
from tools import python_repl, read_file
```

This works when running the script directly from the `baseline/react/` directory (e.g., `cd baseline/react && python agent.py`). For the `run_dabench_mini.py` script, we'll use `sys.path` injection (see Step 3).

- [ ] **Step 3: Update `baseline/react/run_dabench_mini.py` — fix import**

Replace the top of the file. The full file becomes:

```python
"""Minimal DABench validation: run baseline agent on a few questions."""

import sys
from pathlib import Path

# Allow importing agent.py and tools.py as standalone modules
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rich.console import Console
from rich.table import Table

from statigent.benchmarks.dabench import DABenchAdapter

from agent import ReactBaselineAgent


def main() -> None:
    console = Console()
    console.print("[bold]DABench Minimal Validation[/bold]")

    # Setup
    adapter = DABenchAdapter()
    agent = ReactBaselineAgent(model_name="deepseek-v4-flash")

    # Prepare
    console.print("\n[blue]Step 1: Preparing DABench data...[/blue]")
    adapter.prepare()
    console.print(f"  Loaded {len(adapter._questions)} questions")

    # Run on a few questions
    console.print("\n[blue]Step 2: Running baseline agent (3 questions)...[/blue]")
    predictions = adapter.run(agent, limit=3)
    console.print(f"  Got {len(predictions)} predictions")

    for pred in predictions:
        console.print(f"  id={pred['id']}: {pred['response'][:80]}...")

    # Evaluate
    console.print("\n[blue]Step 3: Evaluating predictions...[/blue]")
    result = adapter.evaluate(
        predictions,
        agent_name=agent.name,
        model_name=agent.model_name,
    )

    # Display results
    table = Table(title="Evaluation Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")
    table.add_row("ABQ", f"{result.details.get('abq', 'N/A')}")
    table.add_row("PSAQ", f"{result.details.get('psaq', 'N/A')}")
    table.add_row("UASQ", f"{result.details.get('uasq', 'N/A')}")
    table.add_row("Agent", result.agent_name)
    table.add_row("Model", result.model_name)
    console.print(table)

    console.print("\n[bold green]Validation complete![/bold green]")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Verify imports work**

Run: `cd baseline/react && uv run python -c "from agent import ReactBaselineAgent; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Run linter**

Run: `uv run ruff check baseline/react/agent.py baseline/react/run_dabench_mini.py`
Expected: No errors (may need to add `baseline` to ruff src or use `--extend-ignore` for import style since these are scripts, not a package)

If ruff complains about the `from tools import` or `from agent import` style, add a `# noqa: INP001` at the top of each script file to suppress "implicit namespace package" warnings, and `# noqa: TID252` for relative-style imports if needed.

- [ ] **Step 6: Commit**

```bash
git add -A baseline/react/
git commit -m "refactor: restructure baseline/react from package to standalone scripts"
```

---

### Task 2: Separate agent system prompt from benchmark task instructions

**Files:**
- Modify: `baseline/react/agent.py`
- Modify: `src/statigent/benchmarks/base.py`
- Modify: `src/statigent/benchmarks/dabench.py`
- Modify: `src/statigent/benchmarks/dsbench.py`
- Modify: `src/statigent/benchmarks/mlebench.py`
- Modify: `tests/benchmarks/test_base.py`

The key change: `DataScienceAgent.run_analysis_for_eval()` and `run_modeling_for_eval()` accept a `task_instructions` keyword argument. The agent appends these to its system prompt or includes them in the user message. Each adapter builds benchmark-specific instructions in its `run()` method.

- [ ] **Step 1: Update `DataScienceAgent` protocol in `base.py`**

Replace the `DataScienceAgent` class (lines 74-95) with:

```python
class DataScienceAgent(Protocol):
    """Protocol that agents must satisfy to be evaluated by benchmarks."""

    name: str
    model_name: str

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> str:
        """Run agent on an analysis task, return text response.

        Args:
            prompt: The task prompt from the benchmark adapter.
            files: Optional data files the agent should read.
            task_instructions: Benchmark-specific formatting/constraint instructions
                to prepend to the prompt (e.g., output format requirements).
        """
        ...

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
    ) -> Path:
        """Run agent on a modeling task, return path to prediction CSV.

        Args:
            prompt: The task prompt from the benchmark adapter.
            train_path: Path to training data.
            test_path: Path to test data.
            sample_submission_path: Path to sample submission CSV.
            task_instructions: Benchmark-specific formatting/constraint instructions.
        """
        ...
```

- [ ] **Step 2: Update `EvalResult` and `BenchmarkAdapter.execute()` in `base.py`**

The `EvalResult` dataclass needs no change here (persistence is Task 3). But `execute()` should pass `agent_name` and `model_name` through to `evaluate()`. Replace the `execute()` method:

```python
    def execute(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> EvalResult:
        """Full pipeline: prepare -> run -> evaluate."""
        self.prepare()
        predictions = self.run(agent, **kwargs)
        return self.evaluate(
            predictions,
            agent_name=agent.name,
            model_name=agent.model_name,
            **kwargs,
        )
```

- [ ] **Step 3: Update `baseline/react/agent.py` — split system prompt**

Replace the full file:

```python
"""React baseline agent implementing the DataScienceAgent protocol."""

from pathlib import Path

from langchain.agents import create_agent
from loguru import logger

from statigent.models import get_model
from tools import python_repl, read_file

_SYSTEM_PROMPT = """You are a data science assistant with access to the following tools:
1. read_file — Read the contents of a file (CSV, text, etc.)
2. python_repl — Execute Python code (pandas, numpy, scikit-learn, etc.)

General guidelines:
- Read relevant data files before attempting analysis
- Write and execute Python code to perform computations
- Print results clearly so they can be captured
- For modeling tasks, generate predictions and save them as CSV files
"""


class ReactBaselineAgent:
    """Simple react baseline agent using langchain's create_agent."""

    name = "react-baseline"

    def __init__(self, model_name: str = "deepseek-v4-flash") -> None:
        self.model_name = model_name
        llm = get_model(model_name)
        self.agent = create_agent(
            llm,
            [python_repl, read_file],
            system_prompt=_SYSTEM_PROMPT,
        )

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> str:
        """Run agent on an analysis task, return text response."""
        file_info = ""
        if files:
            file_info = "\n\nAvailable data files:\n" + "\n".join(
                f"- {f}" for f in files
            )

        parts = []
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(file_info)

        result = self.agent.invoke(
            {"messages": [{"role": "user", "content": "\n\n".join(parts)}]}
        )
        response = result["messages"][-1].content
        logger.debug("ReactBaselineAgent response: {}...", response[:100])
        return response

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
    ) -> Path:
        """Run agent on a modeling task, return path to prediction CSV."""
        output_path = train_path.parent / "submission.csv"
        parts = []
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(
            f"Training data: {train_path}\n"
            f"Test data: {test_path}\n"
            f"Sample submission: {sample_submission_path}\n"
            f"Save your predictions to: {output_path}\n\n"
            "Read the training data, build a model, generate predictions "
            "for the test data, and save them as a CSV file matching "
            f"the sample submission format to {output_path}."
        )

        self.agent.invoke(
            {"messages": [{"role": "user", "content": "\n\n".join(parts)}]}
        )

        if not output_path.exists():
            logger.warning("Submission file not created at {}", output_path)
        return output_path
```

Key changes:
- System prompt stripped to role + tools + general guidelines only
- No DABench-specific `@answer_name[value]` format, rounding constraints, etc.
- `task_instructions` parameter added to both methods
- `task_instructions` prepended to the user message when provided

- [ ] **Step 4: Update DABenchAdapter to inject task instructions in `run()`**

In `src/statigent/benchmarks/dabench.py`, replace the `run()` method (lines 61-79) with:

```python
    def run(self, agent: DataScienceAgent, **kwargs: Any) -> list[dict[str, Any]]:
        """Run agent on DABench questions."""
        limit = kwargs.get("limit")
        questions = self._questions[:limit] if limit else self._questions

        predictions: list[dict[str, Any]] = []
        for q in questions:
            csv_path = self.data_dir / "da-dev-tables" / q["file_name"]
            task_instructions = (
                "## Task Instructions\n"
                "You are answering a closed-form data analysis question. "
                "Follow these rules strictly:\n"
                "- Print the final answer in the required output format\n"
                f"- Output format: {q['format']}\n"
                "- If the format is @answer_name[value], follow it exactly\n"
                f"- Constraints: {q['constraints']}\n"
                "- For numerical answers, print the number clearly\n"
            )
            prompt = (
                f"Question: {q['question']}\n\n"
                f"Data file: {csv_path}"
            )
            response = agent.run_analysis_for_eval(
                prompt, files=[csv_path], task_instructions=task_instructions
            )
            predictions.append({"id": q["id"], "response": response})
            logger.debug("DABench question id={}: response received", q["id"])

        return predictions
```

Key change: The `Output format` and `Constraints` are now in `task_instructions`, not embedded in the user prompt. The user prompt only contains the question and data file path.

- [ ] **Step 5: Update DSBenchAdapter to inject task instructions in `run()`**

In `src/statigent/benchmarks/dsbench.py`, update `_run_data_analysis` and `_run_data_modeling`:

Replace `_run_data_analysis` (lines 70-95):

```python
    _DA_TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are answering a data analysis question about a financial or business "
        "scenario. Provide a clear, concise answer based on the data. "
        "If the question asks for a specific value, state it explicitly.\n"
    )

    def _run_data_analysis(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> list[dict[str, Any]]:
        """Run data analysis task."""
        limit = kwargs.get("limit")
        samples = self._samples[:limit] if limit else self._samples

        predictions: list[dict[str, Any]] = []
        for sample in samples:
            if not sample.get("questions"):
                continue
            sid = sample["id"]
            data_base = self.data_dir / "data_analysis" / "data" / sid

            intro_path = data_base / "introduction.txt"
            introduction = intro_path.read_text() if intro_path.exists() else ""

            for qname in sample["questions"]:
                q_path = data_base / f"{qname}.txt"
                question = q_path.read_text() if q_path.exists() else ""
                prompt = f"{introduction}\n\n{question}"
                response = agent.run_analysis_for_eval(
                    prompt, task_instructions=self._DA_TASK_INSTRUCTIONS
                )
                predictions.append({"id": sid, "response": response})
                logger.debug(
                    "DSBench DA id={} q={}: response received", sid, qname
                )

        return predictions
```

Replace `_run_data_modeling` (lines 97-150):

```python
    _DM_TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are building a predictive model for a data science competition. "
        "Follow these steps:\n"
        "1. Read the training data and understand the features\n"
        "2. Build a model using Python (scikit-learn, xgboost, etc.)\n"
        "3. Generate predictions for the test data\n"
        "4. Save predictions as a CSV file matching the sample submission format\n"
    )

    def _run_data_modeling(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> list[dict[str, Any]]:
        """Run data modeling task."""
        limit = kwargs.get("limit")
        samples = self._samples[:limit] if limit else self._samples

        predictions: list[dict[str, Any]] = []
        for sample in samples:
            name = sample["name"]
            task_path = (
                self.data_dir / "data_modeling" / "data" / "task" / f"{name}.txt"
            )
            description = task_path.read_text() if task_path.exists() else ""

            train_path = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "train.csv"
            )
            test_path = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "test.csv"
            )
            sample_sub = (
                self.data_dir
                / "data_modeling"
                / "data"
                / "data_resplit"
                / name
                / "sample_submission.csv"
            )

            if not train_path.exists():
                logger.warning("DSBench DM skipping {}: train.csv not found", name)
                continue

            pred_path = agent.run_modeling_for_eval(
                description,
                train_path=train_path,
                test_path=test_path,
                sample_submission_path=sample_sub,
                task_instructions=self._DM_TASK_INSTRUCTIONS,
            )
            predictions.append({"name": name, "prediction_path": str(pred_path)})
            logger.debug("DSBench DM {}: prediction saved", name)

        return predictions
```

- [ ] **Step 6: Update MLEBenchAdapter to inject task instructions in `run()`**

In `src/statigent/benchmarks/mlebench.py`, add a class-level constant and update the `run()` method:

Add after line 29 (`name = "mlebench"`):

```python
    _TASK_INSTRUCTIONS = (
        "## Task Instructions\n"
        "You are competing in a Kaggle-style ML competition. "
        "Follow these steps:\n"
        "1. Read the competition description and understand the evaluation metric\n"
        "2. Explore the provided data files\n"
        "3. Build a model to make predictions on the test set\n"
        "4. Save your predictions as a CSV file matching the sample submission format\n"
    )
```

Replace the `run()` method (lines 75-108):

```python
    def run(self, agent: "DataScienceAgent", **kwargs: Any) -> list[dict[str, Any]]:
        """Run agent on MLE-Bench competitions."""
        limit = kwargs.get("limit")

        competition_ids = self._get_competition_ids()
        if limit:
            competition_ids = competition_ids[: int(limit)]

        predictions: list[dict[str, Any]] = []
        for comp_id in competition_ids:
            comp_dir = self.data_dir / comp_id / "prepared" / "public"
            desc_path = (
                self.repo_dir / "mlebench" / "competitions" / comp_id / "description.md"
            )

            if not comp_dir.exists():
                logger.warning("MLE-Bench skipping {}: data not prepared", comp_id)
                continue

            description = desc_path.read_text() if desc_path.exists() else ""
            sample_sub = comp_dir / "sample_submission.csv"

            pred_path = agent.run_modeling_for_eval(
                description,
                train_path=comp_dir,
                test_path=comp_dir,
                sample_submission_path=sample_sub,
                task_instructions=self._TASK_INSTRUCTIONS,
            )
            predictions.append(
                {"competition_id": comp_id, "submission_path": str(pred_path)}
            )
            logger.debug("MLE-Bench {}: submission created", comp_id)

        return predictions
```

- [ ] **Step 7: Update `tests/benchmarks/test_base.py`**

Update `TestDataScienceAgentProtocol.test_protocol_compliant_class` to include `task_instructions`:

Replace the `MyAgent` class in the test (lines 85-107):

```python
class TestDataScienceAgentProtocol:
    def test_protocol_compliant_class(self):
        class MyAgent:
            name = "my-agent"
            model_name = "deepseek-v4-flash"

            def run_analysis_for_eval(
                self,
                prompt: str,
                *,
                files: list[Path] | None = None,
                task_instructions: str = "",
            ) -> str:
                return "answer"

            def run_modeling_for_eval(
                self,
                prompt: str,
                *,
                train_path: Path,
                test_path: Path,
                sample_submission_path: Path,
                task_instructions: str = "",
            ) -> Path:
                return Path("submission.csv")

        agent: DataScienceAgent = MyAgent()
        assert agent.name == "my-agent"
        assert agent.run_analysis_for_eval("test") == "answer"
```

- [ ] **Step 8: Run full test suite**

Run: `uv run pytest tests/benchmarks/ -v`
Expected: All PASS

- [ ] **Step 9: Run linter and type checker**

Run: `uv run ruff check src/statigent/benchmarks/` and `uv run mypy src/statigent/benchmarks/`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add baseline/react/agent.py src/statigent/benchmarks/ tests/benchmarks/
git commit -m "refactor: separate agent system prompt from benchmark task instructions"
```

---

### Task 3: Implement evaluation output persistence

**Files:**
- Create: `src/statigent/benchmarks/persistence.py`
- Create: `tests/benchmarks/test_persistence.py`
- Modify: `src/statigent/benchmarks/base.py`
- Modify: `src/statigent/benchmarks/dabench.py`
- Modify: `src/statigent/benchmarks/dsbench.py`
- Modify: `src/statigent/benchmarks/mlebench.py`
- Modify: `src/statigent/benchmarks/__init__.py`

The spec defines the output structure:

```
evaluations/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/
├── meta.json          # agent_name, model_name, benchmark_name, timestamp, config
├── predictions/       # agent raw output
│   └── responses.jsonl
└── evaluation/        # evaluation results
    └── scores.json
```

We omit `process/` for now (agent interaction traces require instrumenting the agent, which is out of scope for this fix).

- [ ] **Step 1: Write failing tests for `save_eval_result()`**

Create `tests/benchmarks/test_persistence.py`:

```python
import json
from pathlib import Path

from statigent.benchmarks.base import EvalResult, ScoreResult
from statigent.benchmarks.persistence import save_eval_result


class TestSaveEvalResult:
    def test_creates_directory_structure(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.85,
            details={"abq": 0.85, "psaq": 0.9},
            agent_name="react-baseline",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        assert output_dir.exists()
        assert (output_dir / "meta.json").exists()
        assert (output_dir / "evaluation" / "scores.json").exists()

    def test_meta_json_contains_context(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.85,
            details={"abq": 0.85},
            agent_name="react-baseline",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        meta = json.loads((output_dir / "meta.json").read_text())
        assert meta["agent_name"] == "react-baseline"
        assert meta["model_name"] == "deepseek-v4-flash"
        assert meta["benchmark_name"] == "dabench"
        assert "timestamp" in meta

    def test_predictions_saved_as_jsonl(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.5,
            details={},
            agent_name="test-agent",
            model_name="test-model",
            benchmark_name="dabench",
        )
        predictions = [
            {"id": 0, "response": "@count[891]"},
            {"id": 1, "response": "@mean[34.5]"},
        ]
        output_dir = save_eval_result(
            result, predictions=predictions, base_dir=tmp_path
        )
        pred_file = output_dir / "predictions" / "responses.jsonl"
        assert pred_file.exists()
        lines = pred_file.read_text().strip().split("\n")
        assert len(lines) == 2
        assert json.loads(lines[0])["id"] == 0

    def test_scores_json_contains_result(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.75,
            details={"abq": 0.75, "psaq": 0.8},
            agent_name="test-agent",
            model_name="test-model",
            benchmark_name="dsbench-da",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        scores = json.loads(
            (output_dir / "evaluation" / "scores.json").read_text()
        )
        assert scores["score"] == 0.75
        assert scores["details"]["abq"] == 0.75
        assert scores["benchmark_name"] == "dsbench-da"

    def test_directory_name_format(self, tmp_path: Path) -> None:
        result = EvalResult(
            score=0.0,
            details={},
            agent_name="react-baseline",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        output_dir = save_eval_result(result, predictions=[], base_dir=tmp_path)
        dir_name = output_dir.name
        assert dir_name.startswith("react-baseline-deepseek-v4-flash-dabench-")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/benchmarks/test_persistence.py -v`
Expected: FAIL — `ImportError` for `persistence` module

- [ ] **Step 3: Implement `persistence.py`**

Create `src/statigent/benchmarks/persistence.py`:

```python
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from statigent.benchmarks.base import EvalResult


def save_eval_result(
    result: EvalResult,
    predictions: list[dict[str, Any]],
    base_dir: Path | None = None,
) -> Path:
    """Persist evaluation result and predictions to disk.

    Creates:
        {base_dir}/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/
        ├── meta.json
        ├── predictions/
        │   └── responses.jsonl
        └── evaluation/
            └── scores.json

    Args:
        result: The evaluation result to persist.
        predictions: The raw agent predictions.
        base_dir: Base directory for output. Defaults to ./evaluations/

    Returns:
        Path to the created output directory.
    """
    if base_dir is None:
        base_dir = Path("evaluations")

    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dir_name = f"{result.agent_name}-{result.model_name}-{result.benchmark_name}-{timestamp}"
    output_dir = base_dir / dir_name
    output_dir.mkdir(parents=True, exist_ok=True)

    # meta.json
    meta: dict[str, Any] = {
        "agent_name": result.agent_name,
        "model_name": result.model_name,
        "benchmark_name": result.benchmark_name,
        "timestamp": timestamp,
    }
    (output_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    # predictions/responses.jsonl
    pred_dir = output_dir / "predictions"
    pred_dir.mkdir(exist_ok=True)
    if predictions:
        lines = [json.dumps(p) for p in predictions]
        (pred_dir / "responses.jsonl").write_text("\n".join(lines) + "\n")
    else:
        (pred_dir / "responses.jsonl").write_text("")

    # evaluation/scores.json
    eval_dir = output_dir / "evaluation"
    eval_dir.mkdir(exist_ok=True)
    scores: dict[str, Any] = {
        "score": result.score,
        "details": result.details,
        "agent_name": result.agent_name,
        "model_name": result.model_name,
        "benchmark_name": result.benchmark_name,
    }
    (eval_dir / "scores.json").write_text(json.dumps(scores, indent=2))

    return output_dir
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/benchmarks/test_persistence.py -v`
Expected: All PASS

- [ ] **Step 5: Wire persistence into `BenchmarkAdapter.execute()`**

In `src/statigent/benchmarks/base.py`, update `execute()` to accept `output_dir` and persist results:

Replace the `execute()` method:

```python
    def execute(
        self, agent: "DataScienceAgent", **kwargs: Any
    ) -> EvalResult:
        """Full pipeline: prepare -> run -> evaluate -> persist."""
        from statigent.benchmarks.persistence import save_eval_result

        self.prepare()
        predictions = self.run(agent, **kwargs)
        result = self.evaluate(
            predictions,
            agent_name=agent.name,
            model_name=agent.model_name,
            **kwargs,
        )

        output_dir = kwargs.get("output_dir")
        if output_dir is not None:
            save_eval_result(
                result,
                predictions=predictions,
                base_dir=Path(output_dir),
            )
        else:
            # Default: save to ./evaluations/
            save_eval_result(result, predictions=predictions)

        return result
```

- [ ] **Step 6: Remove `agent_name`/`model_name` kwargs from adapter `evaluate()` methods**

Now that `execute()` passes `agent_name` and `model_name` through, the adapters should use them from kwargs but they no longer need to default to "unknown" since `execute()` always provides them.

In `src/statigent/benchmarks/dabench.py`, replace the `evaluate()` method:

```python
    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score DABench predictions."""
        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        responses = predictions
        if self.reformat:
            reformatter = ReformatEvaluator(model_name=self.reformat_model)
            responses = reformatter.reformat(responses, self._questions)

        evaluator = ExactMatchEvaluator()
        score_result = evaluator.evaluate(responses, self._labels)

        return EvalResult.from_score_result(
            score_result,
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=self.name,
        )
```

In `src/statigent/benchmarks/dsbench.py`, replace the `evaluate()` and `_evaluate_data_analysis()` methods:

```python
    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score DSBench predictions."""
        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        if self.task == "data_analysis":
            return self._evaluate_data_analysis(predictions, agent_name, model_name)
        raise StatigentBenchmarkError(
            "DSBench data_modeling evaluation requires running per-competition "
            "eval scripts — not yet implemented in the adapter layer"
        )
```

In `src/statigent/benchmarks/mlebench.py`, replace the `evaluate()` method:

```python
    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score MLE-Bench predictions using mlebench grade."""
        agent_name = kwargs["agent_name"]
        model_name = kwargs["model_name"]

        if not predictions:
            return EvalResult(
                score=0.0,
                details={},
                agent_name=agent_name,
                model_name=model_name,
                benchmark_name=self.name,
            )
```

(Rest of the method body stays the same.)

- [ ] **Step 7: Update existing tests that call `adapter.evaluate()` directly**

Tests that call `adapter.evaluate()` directly now need to pass `agent_name` and `model_name` as kwargs. The existing tests already do this (e.g., `adapter.evaluate(predictions, agent_name="test", model_name="test-model")`), so they should still pass. Verify:

Run: `uv run pytest tests/benchmarks/ -v`
Expected: All PASS

- [ ] **Step 8: Run linter and type checker**

Run: `uv run ruff check src/statigent/benchmarks/` and `uv run mypy src/statigent/benchmarks/`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/statigent/benchmarks/persistence.py src/statigent/benchmarks/base.py src/statigent/benchmarks/dabench.py src/statigent/benchmarks/dsbench.py src/statigent/benchmarks/mlebench.py src/statigent/benchmarks/__init__.py tests/benchmarks/test_persistence.py tests/benchmarks/test_base.py
git commit -m "feat: add evaluation output persistence and wire into execute() pipeline"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| `baseline/react` as scripts, not package | Task 1 |
| Remove `__init__.py` from `baseline/react/` | Task 1 |
| Agent system prompt = role + tools + style only | Task 2 |
| Benchmark task instructions in adapter `run()` | Task 2 |
| `task_instructions` parameter in `DataScienceAgent` protocol | Task 2 |
| Evaluation output to `evaluations/{name}-{model}-{bench}-{ts}/` | Task 3 |
| `meta.json` with agent/model/benchmark/timestamp | Task 3 |
| `predictions/responses.jsonl` | Task 3 |
| `evaluation/scores.json` | Task 3 |
| `execute()` automatically persists results | Task 3 |
| `execute()` passes `agent_name`/`model_name` to `evaluate()` | Task 2 |

### Placeholder Scan

- No TBD, TODO, or "implement later" in any step
- All code blocks contain complete implementations
- No "similar to Task N" shortcuts

### Type Consistency

- `task_instructions: str = ""` used consistently in `DataScienceAgent` protocol, `ReactBaselineAgent`, and all adapter `run()` calls
- `EvalResult` fields unchanged — `score`, `details`, `agent_name`, `model_name`, `benchmark_name`
- `save_eval_result()` signature: `(result: EvalResult, predictions: list[dict[str, Any]], base_dir: Path | None = None) -> Path`
- `execute()` kwargs include `output_dir` for custom persistence location
- `predictions` parameter in `save_eval_result()` matches the return type of adapter `run()` methods (`list[dict[str, Any]]`)
