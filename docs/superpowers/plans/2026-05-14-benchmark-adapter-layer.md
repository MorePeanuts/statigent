# Benchmark Adapter Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a unified benchmark evaluation layer for DABench, DSBench, and MLE-Bench, with a baseline react agent and minimal DABench validation.

**Architecture:** Adapter + Evaluator pattern. Each benchmark has a `BenchmarkAdapter` subclass that handles data prep, agent execution, and evaluation. Evaluators are composable (ExactMatch, LLMJudge, Metric, Reformat). All LLM calls go through `statigent.models`. Evaluation results go to `evaluations/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/`.

**Tech Stack:** Python 3.12+, langchain 1.3+, langchain-experimental (PythonREPL), statigent.models, pytest

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/statigent/benchmarks/__init__.py` | Public API: `run_benchmark`, `list_benchmarks`, `get_benchmark` |
| Create | `src/statigent/benchmarks/base.py` | `ScoreResult`, `EvalResult`, `Evaluator` ABC, `BenchmarkAdapter` ABC, `DataScienceAgent` Protocol |
| Create | `src/statigent/benchmarks/evaluators.py` | `ExactMatchEvaluator`, `LLMJudgeEvaluator`, `MetricEvaluator`, `ReformatEvaluator` |
| Create | `src/statigent/benchmarks/dabench.py` | `DABenchAdapter` |
| Create | `src/statigent/benchmarks/dsbench.py` | `DSBenchAdapter` |
| Create | `src/statigent/benchmarks/mlebench.py` | `MLEBenchAdapter` |
| Create | `src/statigent/errors.py` (modify) | Add `StatigentBenchmarkError` |
| Create | `tests/benchmarks/test_base.py` | Tests for base abstractions |
| Create | `tests/benchmarks/test_evaluators.py` | Tests for all evaluators |
| Create | `tests/benchmarks/test_dabench.py` | Tests for DABench adapter |
| Create | `tests/benchmarks/test_dsbench.py` | Tests for DSBench adapter |
| Create | `tests/benchmarks/test_mlebench.py` | Tests for MLE-Bench adapter |
| Create | `baseline/react/agent.py` | `ReactBaselineAgent` implementing `DataScienceAgent` |
| Create | `baseline/react/__init__.py` | Package init |
| Create | `baseline/react/tools.py` | PythonREPL + file read tools |
| Modify | `.gitignore` | Add `benchmarks/data/`, `evaluations/` |
| Modify | `src/statigent/__init__.py` | Export benchmark public API |

---

### Task 1: Error types and .gitignore

**Files:**
- Modify: `src/statigent/errors.py`
- Modify: `.gitignore`

- [ ] **Step 1: Add StatigentBenchmarkError to errors.py**

Add after the existing `StatigentModelError` class:

```python
class StatigentBenchmarkError(StatigentError):
    """Error raised by the benchmark adapter layer."""
```

- [ ] **Step 2: Update .gitignore**

Append these lines to `.gitignore`:

```
# Benchmark data (large datasets)
benchmarks/data/

# Evaluation outputs
evaluations/
```

- [ ] **Step 3: Run linter**

Run: `uv run ruff check src/statigent/errors.py`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/statigent/errors.py .gitignore
git commit -m "feat: add StatigentBenchmarkError and gitignore entries for benchmark data/evaluations"
```

---

### Task 2: Core abstractions (base.py)

**Files:**
- Create: `src/statigent/benchmarks/base.py`
- Create: `tests/benchmarks/test_base.py`

- [ ] **Step 1: Write failing tests for base abstractions**

Create `tests/benchmarks/test_base.py`:

```python
from pathlib import Path
from typing import Any

import pytest

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    DataScienceAgent,
    EvalResult,
    ScoreResult,
)


class TestScoreResult:
    def test_score_result_creation(self):
        result = ScoreResult(score=0.85, details={"metric": "accuracy"})
        assert result.score == 0.85
        assert result.details == {"metric": "accuracy"}


class TestEvalResult:
    def test_eval_result_creation(self):
        result = EvalResult(
            score=0.85,
            details={"metric": "accuracy"},
            agent_name="react-baseline",
            model_name="deepseek-v4-flash",
            benchmark_name="dabench",
        )
        assert result.score == 0.85
        assert result.agent_name == "react-baseline"
        assert result.model_name == "deepseek-v4-flash"
        assert result.benchmark_name == "dabench"

    def test_eval_result_from_score_result(self):
        sr = ScoreResult(score=0.9, details={"abq": 0.8, "psaq": 0.9})
        er = EvalResult.from_score_result(
            sr,
            agent_name="my-agent",
            model_name="my-model",
            benchmark_name="dsbench",
        )
        assert er.score == 0.9
        assert er.details == {"abq": 0.8, "psaq": 0.9}
        assert er.agent_name == "my-agent"
        assert er.benchmark_name == "dsbench"


class TestBenchmarkAdapterABC:
    def test_cannot_instantiate_abc(self):
        with pytest.raises(TypeError):
            BenchmarkAdapter()  # type: ignore[abstract]

    def test_concrete_subclass_must_implement_methods(self):
        class IncompleteAdapter(BenchmarkAdapter):
            name = "incomplete"

        with pytest.raises(TypeError):
            IncompleteAdapter()  # type: ignore[abstract]

    def test_concrete_subclass_with_all_methods(self):
        class DummyAdapter(BenchmarkAdapter):
            name = "dummy"

            def prepare(self) -> None:
                pass

            def run(self, agent: DataScienceAgent, **kwargs: Any) -> Any:
                return []

            def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
                return EvalResult(
                    score=0.0,
                    details={},
                    agent_name=agent.name,
                    model_name=agent.model_name,
                    benchmark_name=self.name,
                )

        adapter = DummyAdapter()
        assert adapter.name == "dummy"


class TestDataScienceAgentProtocol:
    def test_protocol_compliant_class(self):
        class MyAgent:
            name = "my-agent"
            model_name = "deepseek-v4-flash"

            def run_analysis_for_eval(
                self, prompt: str, *, files: list[Path] | None = None
            ) -> str:
                return "answer"

            def run_modeling_for_eval(
                self,
                prompt: str,
                *,
                train_path: Path,
                test_path: Path,
                sample_submission_path: Path,
            ) -> Path:
                return Path("submission.csv")

        agent: DataScienceAgent = MyAgent()
        assert agent.name == "my-agent"
        assert agent.run_analysis_for_eval("test") == "answer"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/benchmarks/test_base.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'statigent.benchmarks'`

- [ ] **Step 3: Create benchmarks package with base.py**

Create `src/statigent/benchmarks/__init__.py` (empty for now).

Create `src/statigent/benchmarks/base.py`:

```python
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


@dataclass
class ScoreResult:
    """Result returned by an Evaluator (score + details only)."""

    score: float
    details: dict[str, Any]


@dataclass
class EvalResult:
    """Full evaluation result with agent/model/benchmark context."""

    score: float
    details: dict[str, Any]
    agent_name: str
    model_name: str
    benchmark_name: str

    @classmethod
    def from_score_result(
        cls,
        score_result: ScoreResult,
        agent_name: str,
        model_name: str,
        benchmark_name: str,
    ) -> EvalResult:
        """Create EvalResult from a ScoreResult plus context."""
        return cls(
            score=score_result.score,
            details=score_result.details,
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=benchmark_name,
        )


class Evaluator(ABC):
    """Abstract base for evaluation strategies."""

    @abstractmethod
    def evaluate(self, predictions: Any, references: Any) -> ScoreResult: ...


class BenchmarkAdapter(ABC):
    """Abstract base for benchmark adapters."""

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


class DataScienceAgent(Protocol):
    """Protocol that agents must satisfy to be evaluated by benchmarks."""

    name: str
    model_name: str

    def run_analysis_for_eval(
        self, prompt: str, *, files: list[Path] | None = None
    ) -> str:
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/benchmarks/test_base.py -v`
Expected: All PASS

- [ ] **Step 5: Run linter and type checker**

Run: `uv run ruff check src/statigent/benchmarks/` and `uv run mypy src/statigent/benchmarks/base.py`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/statigent/benchmarks/__init__.py src/statigent/benchmarks/base.py tests/benchmarks/test_base.py
git commit -m "feat: add benchmark base abstractions (ScoreResult, EvalResult, Evaluator, BenchmarkAdapter, DataScienceAgent)"
```

---

### Task 3: Evaluators

**Files:**
- Create: `src/statigent/benchmarks/evaluators.py`
- Create: `tests/benchmarks/test_evaluators.py`

- [ ] **Step 1: Write failing tests for ExactMatchEvaluator**

Create `tests/benchmarks/test_evaluators.py`:

```python
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from statigent.benchmarks.evaluators import (
    ExactMatchEvaluator,
    LLMJudgeEvaluator,
    ReformatEvaluator,
)


class TestExactMatchEvaluator:
    def test_exact_string_match(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {"id": 0, "common_answers": [["count", "891"]]}
        ]
        responses = [
            {"id": 0, "response": "@count[891]"}
        ]
        result = evaluator.evaluate(responses, labels)
        assert result.score > 0

    def test_float_tolerance_match(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {"id": 0, "common_answers": [["mean_fare", "34.65"]]}
        ]
        responses = [
            {"id": 0, "response": "@mean_fare[34.6500001]"}
        ]
        result = evaluator.evaluate(responses, labels)
        assert result.score > 0

    def test_wrong_answer(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {"id": 0, "common_answers": [["count", "891"]]}
        ]
        responses = [
            {"id": 0, "response": "@count[100]"}
        ]
        result = evaluator.evaluate(responses, labels)
        assert result.score == 0.0

    def test_missing_response_skipped(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {"id": 0, "common_answers": [["count", "891"]]},
            {"id": 1, "common_answers": [["total", "100"]]},
        ]
        responses = [
            {"id": 0, "response": "@count[891]"}
        ]
        result = evaluator.evaluate(responses, labels)
        # Only id=0 is evaluated; id=1 is skipped
        assert result.details["abq"] == 1.0
        assert result.details["total_questions"] == 1

    def test_multi_answer_question(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {
                "id": 0,
                "common_answers": [
                    ["mean_fare_child", "31.09"],
                    ["mean_fare_teenager", "31.98"],
                ],
            }
        ]
        responses = [
            {"id": 0, "response": "@mean_fare_child[31.09], @mean_fare_teenager[31.98]"}
        ]
        result = evaluator.evaluate(responses, labels)
        assert result.score > 0

    def test_multi_answer_partial_wrong(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {
                "id": 0,
                "common_answers": [
                    ["mean_fare_child", "31.09"],
                    ["mean_fare_teenager", "31.98"],
                ],
            }
        ]
        responses = [
            {"id": 0, "response": "@mean_fare_child[31.09], @mean_fare_teenager[999]"}
        ]
        result = evaluator.evaluate(responses, labels)
        # ABQ = 0 (not all correct), PSAQ = 0.5, UASQ = 0.5
        assert result.details["abq"] == 0.0
        assert result.details["psaq"] == pytest.approx(0.5, abs=1e-4)
        assert result.details["uasq"] == pytest.approx(0.5, abs=1e-4)


class TestLLMJudgeEvaluator:
    @patch("statigent.benchmarks.evaluators.get_model")
    def test_judge_returns_true(self, mock_get_model: MagicMock):
        mock_llm = MagicMock()
        mock_response = MagicMock()
        mock_response.content = "True"
        mock_llm.invoke.return_value = mock_response
        mock_get_model.return_value = mock_llm

        evaluator = LLMJudgeEvaluator(judge_model_name="deepseek-v4-flash")
        result = evaluator.evaluate(
            predictions=[{"id": "1", "response": "The answer is 42"}],
            references=[{"id": "1", "answer": "42", "question": "What is 6*7?"}],
        )
        assert result.score > 0

    @patch("statigent.benchmarks.evaluators.get_model")
    def test_judge_returns_false(self, mock_get_model: MagicMock):
        mock_llm = MagicMock()
        mock_response = MagicMock()
        mock_response.content = "False"
        mock_llm.invoke.return_value = mock_response
        mock_get_model.return_value = mock_llm

        evaluator = LLMJudgeEvaluator(judge_model_name="deepseek-v4-flash")
        result = evaluator.evaluate(
            predictions=[{"id": "1", "response": "The answer is 99"}],
            references=[{"id": "1", "answer": "42", "question": "What is 6*7?"}],
        )
        assert result.score == 0.0


class TestReformatEvaluator:
    @patch("statigent.benchmarks.evaluators.get_model")
    def test_reformat_calls_llm(self, mock_get_model: MagicMock):
        mock_llm = MagicMock()
        mock_response = MagicMock()
        mock_response.content = "@count[891]"
        mock_llm.invoke.return_value = mock_response
        mock_get_model.return_value = mock_llm

        evaluator = ReformatEvaluator(model_name="deepseek-v4-flash")
        questions = [{"id": 0, "format": "@count[count]"}]
        responses = [{"id": 0, "response": "The total count is 891"}]
        result = evaluator.reformat(responses, questions)
        assert len(result) == 1
        assert "@count[891]" in result[0]["response"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/benchmarks/test_evaluators.py -v`
Expected: FAIL — `ImportError` for `evaluators` module

- [ ] **Step 3: Implement evaluators.py**

Create `src/statigent/benchmarks/evaluators.py`:

```python
from __future__ import annotations

import re
from typing import Any

from langchain.chat_models import BaseChatModel
from loguru import logger

from statigent.benchmarks.base import ScoreResult, Evaluator
from statigent.models import get_model

_ANSWER_PATTERN = re.compile(r"@(\w+)\[(.*?)\]")


def _extract_format(input_string: str) -> tuple[list[str], list[str]]:
    """Extract answer_name and answer value pairs from @name[value] format."""
    matches = _ANSWER_PATTERN.findall(input_string)
    names = [m[0] for m in matches]
    values = [m[1] for m in matches]
    return names, values


def _is_equal(response: str, label: str) -> bool:
    """Compare two answers: exact string match or float within 1e-6."""
    if response == label:
        return True
    try:
        return abs(float(response) - float(label)) < 1e-6
    except (ValueError, TypeError):
        return False


class ExactMatchEvaluator(Evaluator):
    """Closed-form exact-match evaluator for DABench-style benchmarks."""

    def evaluate(self, predictions: Any, references: Any) -> ScoreResult:
        labels: list[dict[str, Any]] = references
        responses: list[dict[str, Any]] = predictions

        response_map = {r["id"]: r["response"] for r in responses}

        results: list[dict[str, Any]] = []
        for label in labels:
            qid = label["id"]
            if qid not in response_map:
                continue

            pred_names, pred_values = _extract_format(response_map[qid])
            pred_map = dict(zip(pred_names, pred_values))

            correctness: dict[str, bool] = {}
            label_answers: dict[str, str] = {}
            for name, value in label["common_answers"]:
                label_answers[name] = value
                correctness[name] = _is_equal(pred_map.get(name, ""), value)

            results.append({
                "id": qid,
                "label_answers": label_answers,
                "predicted_answers": pred_map,
                "correctness": correctness,
            })

        if not results:
            return ScoreResult(score=0.0, details={"abq": 0.0, "psaq": 0.0, "uasq": 0.0, "total_questions": 0})

        abq = self._accuracy_by_question(results)
        psaq = self._accuracy_proportional(results)
        uasq = self._accuracy_by_sub_question(results)

        return ScoreResult(
            score=abq,
            details={
                "abq": abq,
                "psaq": psaq,
                "uasq": uasq,
                "total_questions": len(results),
                "per_question": results,
            },
        )

    @staticmethod
    def _accuracy_by_question(results: list[dict[str, Any]]) -> float:
        correct = sum(1 for r in results if all(r["correctness"].values()))
        return round(correct / len(results), 4)

    @staticmethod
    def _accuracy_proportional(results: list[dict[str, Any]]) -> float:
        scores = []
        for r in results:
            vals = list(r["correctness"].values())
            scores.append(sum(vals) / len(vals))
        return round(sum(scores) / len(scores), 4)

    @staticmethod
    def _accuracy_by_sub_question(results: list[dict[str, Any]]) -> float:
        total = 0
        correct = 0
        for r in results:
            vals = list(r["correctness"].values())
            total += len(vals)
            correct += sum(vals)
        return round(correct / total, 4)


_JUDGE_PROMPT = (
    "Please judge whether the generated answer is right or wrong. "
    "We require that the correct answer to the prediction gives a clear answer, "
    "not just a calculation process or a disassembly of ideas. "
    "The question is {question}. The true answer is {answer}. "
    "The predicted answer is {prediction}. "
    "If the predicted answer is right, please output True. "
    "Otherwise output False. "
    "Don't output any other text content. "
    "You only can output True or False."
)


class LLMJudgeEvaluator(Evaluator):
    """LLM-as-judge evaluator using statigent.models."""

    def __init__(self, judge_model_name: str = "deepseek-v4-flash") -> None:
        self.judge_model_name = judge_model_name
        self._llm: BaseChatModel | None = None

    def _get_llm(self) -> BaseChatModel:
        if self._llm is None:
            self._llm = get_model(self.judge_model_name)
        return self._llm

    def evaluate(self, predictions: Any, references: Any) -> ScoreResult:
        refs: list[dict[str, Any]] = references
        preds: list[dict[str, Any]] = predictions

        pred_map = {p["id"]: p["response"] for p in preds}
        llm = self._get_llm()

        verdicts: list[bool] = []
        details: list[dict[str, Any]] = []
        for ref in refs:
            qid = ref["id"]
            prediction = pred_map.get(qid, "")
            prompt = _JUDGE_PROMPT.format(
                question=ref["question"],
                answer=ref["answer"],
                prediction=prediction,
            )
            response = llm.invoke([{"role": "user", "content": prompt}])
            is_correct = "true" in response.content.lower()
            verdicts.append(is_correct)
            details.append({
                "id": qid,
                "verdict": is_correct,
                "raw_response": response.content,
            })
            logger.debug("LLM judge for id={}: verdict={}", qid, is_correct)

        accuracy = sum(verdicts) / len(verdicts) if verdicts else 0.0
        return ScoreResult(
            score=round(accuracy, 4),
            details={"accuracy": accuracy, "total": len(verdicts), "per_question": details},
        )


_REFORMAT_TEMPLATE = (
    "Please reformat the following response to match the required format. "
    "The required format is: {format_template}\n"
    "The original question was: {question}\n"
    "The assistant's response was: {response}\n"
    "Please output the response using the @answer_name[answer] format. "
    "Only output the reformatted answer, nothing else."
)


class ReformatEvaluator:
    """Post-processor that uses an LLM to reformat agent responses."""

    def __init__(self, model_name: str = "deepseek-v4-flash") -> None:
        self.model_name = model_name
        self._llm: BaseChatModel | None = None

    def _get_llm(self) -> BaseChatModel:
        if self._llm is None:
            self._llm = get_model(self.model_name)
        return self._llm

    def reformat(
        self,
        responses: list[dict[str, Any]],
        questions: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Reformat agent responses into @name[value] format using LLM."""
        question_map = {q["id"]: q for q in questions}
        llm = self._get_llm()
        reformatted = []

        for resp in responses:
            qid = resp["id"]
            question = question_map.get(qid)
            if question is None:
                reformatted.append(resp)
                continue

            prompt = _REFORMAT_TEMPLATE.format(
                format_template=question.get("format", ""),
                question=question.get("question", ""),
                response=resp["response"],
            )
            response = llm.invoke([{"role": "user", "content": prompt}])
            reformatted.append({"id": qid, "response": response.content})
            logger.debug("Reformatted id={}", qid)

        return reformatted
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/benchmarks/test_evaluators.py -v`
Expected: All PASS

- [ ] **Step 5: Run linter and type checker**

Run: `uv run ruff check src/statigent/benchmarks/evaluators.py` and `uv run mypy src/statigent/benchmarks/evaluators.py`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/statigent/benchmarks/evaluators.py tests/benchmarks/test_evaluators.py
git commit -m "feat: add evaluators (ExactMatch, LLMJudge, Reformat)"
```

---

### Task 4: DABench Adapter

**Files:**
- Create: `src/statigent/benchmarks/dabench.py`
- Create: `tests/benchmarks/test_dabench.py`

- [ ] **Step 1: Write failing tests for DABenchAdapter**

Create `tests/benchmarks/test_dabench.py`:

```python
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from statigent.benchmarks.dabench import DABenchAdapter


def _write_test_data(tmp_path: Path) -> Path:
    """Write minimal DABench test data and return the data directory."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    tables_dir = data_dir / "da-dev-tables"
    tables_dir.mkdir()

    # Write a sample CSV table
    (tables_dir / "test.csv").write_text("name,age\nAlice,30\nBob,25\n")

    # Write questions
    questions = [
        {
            "id": 0,
            "question": "What is the mean age?",
            "concepts": ["Summary Statistics"],
            "constraints": "Round to 2 decimal places",
            "format": "@mean_age[mean_age]",
            "file_name": "test.csv",
            "level": "easy",
        },
        {
            "id": 1,
            "question": "How many rows are there?",
            "concepts": ["Summary Statistics"],
            "constraints": "Integer answer",
            "format": "@row_count[row_count]",
            "file_name": "test.csv",
            "level": "easy",
        },
    ]
    with open(data_dir / "da-dev-questions.jsonl", "w") as f:
        for q in questions:
            f.write(json.dumps(q) + "\n")

    # Write labels
    labels = [
        {"id": 0, "common_answers": [["mean_age", "27.5"]]},
        {"id": 1, "common_answers": [["row_count", "2"]]},
    ]
    with open(data_dir / "da-dev-labels.jsonl", "w") as f:
        for l in labels:
            f.write(json.dumps(l) + "\n")

    return data_dir


class TestDABenchAdapter:
    def test_prepare_succeeds_with_valid_data(self, tmp_path: Path):
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()  # should not raise

    def test_prepare_fails_with_missing_data(self, tmp_path: Path):
        adapter = DABenchAdapter(data_dir=tmp_path / "nonexistent")
        with pytest.raises(FileNotFoundError):
            adapter.prepare()

    def test_run_collects_responses(self, tmp_path: Path):
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        mock_agent = MagicMock()
        mock_agent.name = "test-agent"
        mock_agent.model_name = "test-model"
        mock_agent.run_analysis_for_eval.return_value = "@mean_age[27.5]"

        predictions = adapter.run(mock_agent, limit=1)
        assert len(predictions) == 1
        assert predictions[0]["id"] == 0
        assert "mean_age" in predictions[0]["response"]

    def test_evaluate_scores_correct_predictions(self, tmp_path: Path):
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        predictions = [
            {"id": 0, "response": "@mean_age[27.5]"},
            {"id": 1, "response": "@row_count[2]"},
        ]
        result = adapter.evaluate(predictions, agent_name="test", model_name="test-model")
        assert result.score == 1.0
        assert result.benchmark_name == "dabench"

    def test_evaluate_partial_correct(self, tmp_path: Path):
        data_dir = _write_test_data(tmp_path)
        adapter = DABenchAdapter(data_dir=data_dir)
        adapter.prepare()

        predictions = [
            {"id": 0, "response": "@mean_age[27.5]"},
            {"id": 1, "response": "@row_count[99]"},
        ]
        result = adapter.evaluate(predictions, agent_name="test", model_name="test-model")
        assert result.details["abq"] == 0.5
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/benchmarks/test_dabench.py -v`
Expected: FAIL — `ImportError` for `dabench` module

- [ ] **Step 3: Implement DABenchAdapter**

Create `src/statigent/benchmarks/dabench.py`:

```python
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    DataScienceAgent,
    EvalResult,
    ScoreResult,
)
from statigent.benchmarks.evaluators import ExactMatchEvaluator, ReformatEvaluator

_DABENCH_DATA_DIR = (
    Path(__file__).resolve().parents[4]
    / "benchmarks"
    / "InfiAgent-DABench"
    / "examples"
    / "DA-Agent"
    / "data"
)


class DABenchAdapter(BenchmarkAdapter):
    """Adapter for the DABench closed-form data analysis benchmark."""

    name = "dabench"

    def __init__(
        self,
        data_dir: Path | None = None,
        reformat: bool = False,
        reformat_model: str = "deepseek-v4-flash",
    ) -> None:
        self.data_dir = data_dir or _DABENCH_DATA_DIR
        self.reformat = reformat
        self.reformat_model = reformat_model
        self._questions: list[dict[str, Any]] = []
        self._labels: list[dict[str, Any]] = []

    def prepare(self) -> None:
        """Verify DABench data files exist."""
        questions_path = self.data_dir / "da-dev-questions.jsonl"
        labels_path = self.data_dir / "da-dev-labels.jsonl"
        tables_dir = self.data_dir / "da-dev-tables"

        for p in (questions_path, labels_path):
            if not p.exists():
                raise FileNotFoundError(f"DABench data file not found: {p}")
        if not tables_dir.exists():
            raise FileNotFoundError(f"DABench tables directory not found: {tables_dir}")

        self._questions = _read_jsonl(questions_path)
        self._labels = _read_jsonl(labels_path)
        logger.info("DABench prepared: {} questions, {} labels", len(self._questions), len(self._labels))

    def run(self, agent: DataScienceAgent, **kwargs: Any) -> list[dict[str, Any]]:
        """Run agent on DABench questions."""
        limit = kwargs.get("limit")
        questions = self._questions[:limit] if limit else self._questions

        predictions: list[dict[str, Any]] = []
        for q in questions:
            csv_path = self.data_dir / "da-dev-tables" / q["file_name"]
            prompt = (
                f"Question: {q['question']}\n\n"
                f"Constraints: {q['constraints']}\n\n"
                f"Output format: {q['format']}\n\n"
                f"Data file: {csv_path}"
            )
            response = agent.run_analysis_for_eval(prompt, files=[csv_path])
            predictions.append({"id": q["id"], "response": response})
            logger.debug("DABench question id={}: response received", q["id"])

        return predictions

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score DABench predictions."""
        agent_name = kwargs.get("agent_name", "unknown")
        model_name = kwargs.get("model_name", "unknown")

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


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read a JSONL file and return a list of dicts."""
    items: list[dict[str, Any]] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/benchmarks/test_dabench.py -v`
Expected: All PASS

- [ ] **Step 5: Run linter and type checker**

Run: `uv run ruff check src/statigent/benchmarks/dabench.py` and `uv run mypy src/statigent/benchmarks/dabench.py`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/statigent/benchmarks/dabench.py tests/benchmarks/test_dabench.py
git commit -m "feat: add DABench adapter with ExactMatch evaluation"
```

---

### Task 5: DSBench Adapter

**Files:**
- Create: `src/statigent/benchmarks/dsbench.py`
- Create: `tests/benchmarks/test_dsbench.py`

- [ ] **Step 1: Write failing tests for DSBenchAdapter**

Create `tests/benchmarks/test_dsbench.py`:

```python
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from statigent.benchmarks.dsbench import DSBenchAdapter


def _write_da_test_data(tmp_path: Path) -> Path:
    """Write minimal DSBench data_analysis test data."""
    base = tmp_path / "DSBench" / "data_analysis"
    data_dir = base / "data"
    data_dir.mkdir(parents=True)

    # Create sample challenge
    challenge_dir = data_dir / "00000001"
    challenge_dir.mkdir()
    (challenge_dir / "introduction.txt").write_text("Financial modeling challenge")
    (challenge_dir / "question1.txt").write_text("What is the total revenue?")
    (challenge_dir / "data.xlsx").write_text("fake excel content")

    # Write data.json
    data = [
        {
            "id": "00000001",
            "name": "test-challenge",
            "url": "",
            "txt": "",
            "questions": ["question1"],
            "answers": ["1000000"],
            "year": 2024,
        }
    ]
    with open(base / "data.json", "w") as f:
        for d in data:
            f.write(json.dumps(d) + "\n")

    return base.parent


def _write_dm_test_data(tmp_path: Path) -> Path:
    """Write minimal DSBench data_modeling test data."""
    base = tmp_path / "DSBench" / "data_modeling"
    data_dir = base / "data"
    task_dir = data_dir / "task"
    answers_dir = data_dir / "answers"
    resplit_dir = data_dir / "data_resplit"
    task_dir.mkdir(parents=True)
    answers_dir.mkdir(parents=True)

    # Write data.json
    data = [{"name": "test-competition", "url": "https://kaggle.com/test", "size": "1kB", "year": 2024}]
    with open(base / "data.json", "w") as f:
        for d in data:
            f.write(json.dumps(d) + "\n")

    # Write task description
    (task_dir / "test-competition.txt").write_text("Predict the target variable")

    return base.parent


class TestDSBenchAdapterDA:
    def test_prepare_verifies_data_analysis(self, tmp_path: Path):
        base = _write_da_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_analysis")
        adapter.prepare()  # should not raise

    def test_prepare_fails_with_missing_data(self, tmp_path: Path):
        adapter = DSBenchAdapter(data_dir=tmp_path / "nonexistent", task="data_analysis")
        with pytest.raises(FileNotFoundError):
            adapter.prepare()

    @patch("statigent.benchmarks.evaluators.get_model")
    def test_evaluate_data_analysis(self, mock_get_model: MagicMock, tmp_path: Path):
        mock_llm = MagicMock()
        mock_response = MagicMock()
        mock_response.content = "True"
        mock_llm.invoke.return_value = mock_response
        mock_get_model.return_value = mock_llm

        base = _write_da_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_analysis")
        adapter.prepare()

        predictions = [{"id": "00000001", "response": "The total revenue is 1000000"}]
        result = adapter.evaluate(predictions, agent_name="test", model_name="test-model")
        assert result.benchmark_name == "dsbench-da"
        assert result.score > 0


class TestDSBenchAdapterDM:
    def test_prepare_verifies_data_modeling(self, tmp_path: Path):
        base = _write_dm_test_data(tmp_path)
        adapter = DSBenchAdapter(data_dir=base, task="data_modeling")
        adapter.prepare()  # should not raise

    def test_invalid_task_raises(self):
        with pytest.raises(ValueError, match="task must be"):
            DSBenchAdapter(data_dir=Path("/tmp"), task="invalid")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/benchmarks/test_dsbench.py -v`
Expected: FAIL — `ImportError`

- [ ] **Step 3: Implement DSBenchAdapter**

Create `src/statigent/benchmarks/dsbench.py`:

```python
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from loguru import logger

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    DataScienceAgent,
    EvalResult,
)
from statigent.benchmarks.evaluators import LLMJudgeEvaluator
from statigent.errors import StatigentBenchmarkError

_DSBENCH_DATA_DIR = Path(__file__).resolve().parents[4] / "benchmarks" / "data" / "DSBench"

TaskType = Literal["data_analysis", "data_modeling"]


class DSBenchAdapter(BenchmarkAdapter):
    """Adapter for the DSBench benchmark (data analysis + data modeling tasks)."""

    name: str

    def __init__(
        self,
        data_dir: Path | None = None,
        task: TaskType = "data_analysis",
        judge_model_name: str = "deepseek-v4-flash",
    ) -> None:
        if task not in ("data_analysis", "data_modeling"):
            raise ValueError(f"task must be 'data_analysis' or 'data_modeling', got '{task}'")
        self.task = task
        self.name = f"dsbench-{task}"
        self.data_dir = data_dir or _DSBENCH_DATA_DIR
        self.judge_model_name = judge_model_name
        self._samples: list[dict[str, Any]] = []

    def prepare(self) -> None:
        """Verify DSBench data files exist."""
        if self.task == "data_analysis":
            data_path = self.data_dir / "data_analysis" / "data.json"
            data_dir = self.data_dir / "data_analysis" / "data"
        else:
            data_path = self.data_dir / "data_modeling" / "data.json"
            data_dir = self.data_dir / "data_modeling" / "data"

        if not data_path.exists():
            raise FileNotFoundError(f"DSBench data file not found: {data_path}")
        if not data_dir.exists():
            raise FileNotFoundError(f"DSBench data directory not found: {data_dir}")

        with open(data_path) as f:
            self._samples = [json.loads(line.strip()) for line in f if line.strip()]
        logger.info("DSBench {} prepared: {} samples", self.task, len(self._samples))

    def run(self, agent: DataScienceAgent, **kwargs: Any) -> list[dict[str, Any]]:
        """Run agent on DSBench tasks."""
        predictions: list[dict[str, Any]] = []

        if self.task == "data_analysis":
            predictions = self._run_data_analysis(agent, **kwargs)
        else:
            predictions = self._run_data_modeling(agent, **kwargs)

        return predictions

    def _run_data_analysis(self, agent: DataScienceAgent, **kwargs: Any) -> list[dict[str, Any]]:
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
                response = agent.run_analysis_for_eval(prompt)
                predictions.append({"id": sid, "response": response})
                logger.debug("DSBench DA id={} q={}: response received", sid, qname)

        return predictions

    def _run_data_modeling(self, agent: DataScienceAgent, **kwargs: Any) -> list[dict[str, Any]]:
        """Run data modeling task."""
        limit = kwargs.get("limit")
        samples = self._samples[:limit] if limit else self._samples

        predictions: list[dict[str, Any]] = []
        for sample in samples:
            name = sample["name"]
            task_path = self.data_dir / "data_modeling" / "data" / "task" / f"{name}.txt"
            description = task_path.read_text() if task_path.exists() else ""

            train_path = self.data_dir / "data_modeling" / "data" / "data_resplit" / name / "train.csv"
            test_path = self.data_dir / "data_modeling" / "data" / "data_resplit" / name / "test.csv"
            sample_sub = (
                self.data_dir / "data_modeling" / "data" / "data_resplit" / name / "sample_submission.csv"
            )

            if not train_path.exists():
                logger.warning("DSBench DM skipping {}: train.csv not found", name)
                continue

            pred_path = agent.run_modeling_for_eval(
                description,
                train_path=train_path,
                test_path=test_path,
                sample_submission_path=sample_sub,
            )
            predictions.append({"name": name, "prediction_path": str(pred_path)})
            logger.debug("DSBench DM {}: prediction saved", name)

        return predictions

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score DSBench predictions."""
        agent_name = kwargs.get("agent_name", "unknown")
        model_name = kwargs.get("model_name", "unknown")

        if self.task == "data_analysis":
            return self._evaluate_data_analysis(predictions, agent_name, model_name)
        raise StatigentBenchmarkError(
            "DSBench data_modeling evaluation requires running per-competition eval scripts — "
            "not yet implemented in the adapter layer"
        )

    def _evaluate_data_analysis(
        self, predictions: list[dict[str, Any]], agent_name: str, model_name: str
    ) -> EvalResult:
        """Evaluate data analysis predictions using LLM judge."""
        refs: list[dict[str, Any]] = []
        for sample in self._samples:
            for qname, answer in zip(sample.get("questions", []), sample.get("answers", [])):
                q_path = (
                    self.data_dir / "data_analysis" / "data" / sample["id"] / f"{qname}.txt"
                )
                question = q_path.read_text() if q_path.exists() else ""
                refs.append({"id": sample["id"], "question": question, "answer": answer})

        evaluator = LLMJudgeEvaluator(judge_model_name=self.judge_model_name)
        score_result = evaluator.evaluate(predictions, refs)
        return EvalResult.from_score_result(
            score_result,
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=self.name,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/benchmarks/test_dsbench.py -v`
Expected: All PASS

- [ ] **Step 5: Run linter and type checker**

Run: `uv run ruff check src/statigent/benchmarks/dsbench.py` and `uv run mypy src/statigent/benchmarks/dsbench.py`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/statigent/benchmarks/dsbench.py tests/benchmarks/test_dsbench.py
git commit -m "feat: add DSBench adapter (data analysis with LLM judge, data modeling stub)"
```

---

### Task 6: MLE-Bench Adapter

**Files:**
- Create: `src/statigent/benchmarks/mlebench.py`
- Create: `tests/benchmarks/test_mlebench.py`

- [ ] **Step 1: Write failing tests for MLEBenchAdapter**

Create `tests/benchmarks/test_mlebench.py`:

```python
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from statigent.benchmarks.mlebench import MLEBenchAdapter


class TestMLEBenchAdapter:
    def test_prepare_calls_mlebench_if_needed(self, tmp_path: Path):
        adapter = MLEBenchAdapter(data_dir=tmp_path, skip_prepare=True)
        adapter.prepare()  # with skip_prepare=True, should not error

    def test_name(self):
        adapter = MLEBenchAdapter(skip_prepare=True)
        assert adapter.name == "mlebench"

    @patch("statigent.benchmarks.mlebench.subprocess")
    def test_prepare_runs_mlebench_prepare(self, mock_subprocess: MagicMock, tmp_path: Path):
        mock_subprocess.run.return_value = MagicMock(returncode=0)
        adapter = MLEBenchAdapter(data_dir=tmp_path, skip_prepare=False, lite=True)
        # This would call mlebench prepare if data is missing
        # For now just verify the adapter is constructed
        assert adapter.lite is True

    def test_evaluate_without_predictions(self, tmp_path: Path):
        adapter = MLEBenchAdapter(data_dir=tmp_path, skip_prepare=True)
        # Empty predictions should return zero score
        result = adapter.evaluate([], agent_name="test", model_name="test-model")
        assert result.benchmark_name == "mlebench"
        assert result.score == 0.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/benchmarks/test_mlebench.py -v`
Expected: FAIL — `ImportError`

- [ ] **Step 3: Implement MLEBenchAdapter**

Create `src/statigent/benchmarks/mlebench.py`:

```python
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from loguru import logger

from statigent.benchmarks.base import (
    BenchmarkAdapter,
    DataScienceAgent,
    EvalResult,
    ScoreResult,
)
from statigent.errors import StatigentBenchmarkError

_MLEBENCH_DATA_DIR = Path(__file__).resolve().parents[4] / "benchmarks" / "data" / "MLE-Bench"
_MLEBENCH_REPO_DIR = Path(__file__).resolve().parents[4] / "benchmarks" / "MLE-Bench"


class MLEBenchAdapter(BenchmarkAdapter):
    """Adapter for the MLE-Bench ML engineering benchmark."""

    name = "mlebench"

    def __init__(
        self,
        data_dir: Path | None = None,
        repo_dir: Path | None = None,
        lite: bool = True,
        skip_prepare: bool = False,
    ) -> None:
        self.data_dir = data_dir or _MLEBENCH_DATA_DIR
        self.repo_dir = repo_dir or _MLEBENCH_REPO_DIR
        self.lite = lite
        self.skip_prepare = skip_prepare
        self._competition_ids: list[str] = []

    def prepare(self) -> None:
        """Verify or download MLE-Bench data via mlebench prepare."""
        if self.skip_prepare:
            logger.info("MLE-Bench prepare skipped (skip_prepare=True)")
            return

        # Check if mlebench CLI is available
        try:
            result = subprocess.run(
                ["mlebench", "prepare", "--lite" if self.lite else "--all",
                 "--data-dir", str(self.data_dir)],
                capture_output=True,
                text=True,
                cwd=str(self.repo_dir),
            )
            if result.returncode != 0:
                raise StatigentBenchmarkError(
                    f"mlebench prepare failed: {result.stderr}"
                )
        except FileNotFoundError:
            raise StatigentBenchmarkError(
                "mlebench CLI not found. Install with: pip install -e benchmarks/MLE-Bench/"
            ) from None

        logger.info("MLE-Bench prepared: data_dir={}", self.data_dir)

    def run(self, agent: DataScienceAgent, **kwargs: Any) -> list[dict[str, Any]]:
        """Run agent on MLE-Bench competitions."""
        limit = kwargs.get("limit")

        # Get competition list from mlebench registry
        competition_ids = self._get_competition_ids()
        if limit:
            competition_ids = competition_ids[:limit]

        predictions: list[dict[str, Any]] = []
        for comp_id in competition_ids:
            comp_dir = self.data_dir / comp_id / "prepared" / "public"
            desc_path = self.repo_dir / "mlebench" / "competitions" / comp_id / "description.md"

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
            )
            predictions.append({
                "competition_id": comp_id,
                "submission_path": str(pred_path),
            })
            logger.debug("MLE-Bench {}: submission created", comp_id)

        return predictions

    def evaluate(self, predictions: Any, **kwargs: Any) -> EvalResult:
        """Score MLE-Bench predictions using mlebench grade."""
        agent_name = kwargs.get("agent_name", "unknown")
        model_name = kwargs.get("model_name", "unknown")

        if not predictions:
            return EvalResult(
                score=0.0,
                details={},
                agent_name=agent_name,
                model_name=model_name,
                benchmark_name=self.name,
            )

        # Grade each submission
        results: list[dict[str, Any]] = []
        for pred in predictions:
            submission_path = Path(pred["submission_path"])
            comp_id = pred["competition_id"]

            if not submission_path.exists():
                results.append({"competition_id": comp_id, "score": None, "medal": None})
                continue

            try:
                result = subprocess.run(
                    ["mlebench", "grade-sample", str(submission_path), comp_id,
                     "--data-dir", str(self.data_dir)],
                    capture_output=True,
                    text=True,
                    cwd=str(self.repo_dir),
                )
                if result.returncode == 0:
                    results.append({"competition_id": comp_id, "grade_output": result.stdout})
                else:
                    results.append({"competition_id": comp_id, "score": None, "error": result.stderr})
            except FileNotFoundError:
                raise StatigentBenchmarkError(
                    "mlebench CLI not found. Install with: pip install -e benchmarks/MLE-Bench/"
                ) from None

        score = sum(1 for r in results if r.get("score") is not None) / len(results) if results else 0.0
        return EvalResult.from_score_result(
            ScoreResult(score=round(score, 4), details={"per_competition": results}),
            agent_name=agent_name,
            model_name=model_name,
            benchmark_name=self.name,
        )

    def detect_violations(
        self,
        submission_dir: Path,
        output_dir: Path,
        judge_model_name: str = "deepseek-v4-flash",
    ) -> dict[str, Any]:
        """Run rule violation detection using statigent.models instead of gpt-4o-mini."""
        from statigent.models import get_model

        # Read the violation prompts from MLE-Bench extras
        prompts_path = self.repo_dir / "extras" / "rule_violation_detector" / "prompts.py"
        if not prompts_path.exists():
            raise StatigentBenchmarkError(f"Violation prompts not found: {prompts_path}")

        llm = get_model(judge_model_name)
        # This is a placeholder — full implementation would read logs/code,
        # construct prompts from prompts.py, and invoke the LLM
        logger.warning("detect_violations is a stub — full implementation pending")
        return {"violations_detected": False, "details": {}}

    def _get_competition_ids(self) -> list[str]:
        """Get competition IDs from the lite or full split."""
        split_file = (
            self.repo_dir / "experiments" / "splits" / ("low.txt" if self.lite else "all.txt")
        )
        if split_file.exists():
            return [line.strip() for line in split_file.read_text().splitlines() if line.strip()]

        # Fallback: list from registry
        import sys
        sys.path.insert(0, str(self.repo_dir))
        try:
            from mlebench.registry import Registry
            registry = Registry(data_dir=self.data_dir)
            if self.lite:
                return registry.get_lite_competition_ids()
            return registry.list_competition_ids()
        except ImportError:
            logger.warning("mlebench not importable, returning empty competition list")
            return []
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/benchmarks/test_mlebench.py -v`
Expected: All PASS

- [ ] **Step 5: Run linter and type checker**

Run: `uv run ruff check src/statigent/benchmarks/mlebench.py` and `uv run mypy src/statigent/benchmarks/mlebench.py`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/statigent/benchmarks/mlebench.py tests/benchmarks/test_mlebench.py
git commit -m "feat: add MLE-Bench adapter with mlebench CLI integration"
```

---

### Task 7: Package public API and __init__.py

**Files:**
- Modify: `src/statigent/benchmarks/__init__.py`
- Modify: `src/statigent/__init__.py`

- [ ] **Step 1: Write benchmarks/__init__.py**

```python
"""Benchmark evaluation adapters for data science agents."""

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
    "dsbench-da": lambda **kw: DSBenchAdapter(task="data_analysis", **kw),
    "dsbench-dm": lambda **kw: DSBenchAdapter(task="data_modeling", **kw),
    "mlebench": MLEBenchAdapter,
}


def list_benchmarks() -> list[str]:
    """List available benchmark names."""
    return list(_REGISTRY.keys())


def get_benchmark(name: str, **kwargs: object) -> BenchmarkAdapter:
    """Get a benchmark adapter by name."""
    if name not in _REGISTRY:
        available = ", ".join(_REGISTRY.keys())
        raise ValueError(f"Unknown benchmark '{name}'. Available: {available}")
    factory = _REGISTRY[name]
    if isinstance(factory, type):
        return factory(**kwargs)  # type: ignore[arg-type]
    return factory(**kwargs)  # type: ignore[arg-type]


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
    "DataScienceAgent",
    "DSBenchAdapter",
    "EvalResult",
    "Evaluator",
    "MLEBenchAdapter",
    "ScoreResult",
    "get_benchmark",
    "list_benchmarks",
    "run_benchmark",
]
```

- [ ] **Step 2: Update src/statigent/__init__.py**

Add benchmark imports to the existing file. The full file becomes:

```python
"""A data science agent for automated analysis, feature engineering, model
building, and insight generation."""

from statigent.models import get_model, list_models, load_registry

__version__ = "0.1.0"

__all__ = ["get_model", "list_models", "load_registry"]
```

(Note: We do NOT re-export benchmark functions from the top-level `__init__.py` to keep the package namespace clean. Users import via `from statigent.benchmarks import ...`.)

- [ ] **Step 3: Run full test suite**

Run: `uv run pytest tests/benchmarks/ -v`
Expected: All PASS

- [ ] **Step 4: Run linter**

Run: `uv run ruff check src/statigent/benchmarks/`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/statigent/benchmarks/__init__.py
git commit -m "feat: add benchmarks package public API (list_benchmarks, get_benchmark, run_benchmark)"
```

---

### Task 8: Baseline React Agent

**Files:**
- Create: `baseline/react/__init__.py`
- Create: `baseline/react/agent.py`
- Create: `baseline/react/tools.py`

- [ ] **Step 1: Create baseline/react/__init__.py**

```python
"""React baseline agent for benchmark evaluation."""
```

- [ ] **Step 2: Create baseline/react/tools.py**

```python
"""Tools for the react baseline agent."""

from pathlib import Path

from langchain.tools import tool
from langchain_experimental.utilities import PythonREPL

_python_repl = PythonREPL()


@tool
def python_repl(code: str) -> str:
    """Execute Python code and return the output.

    Use this to run data analysis code (pandas, numpy, etc.).
    If you want to see the output of a value, use print(...) in your code.
    The current working directory and any provided files are accessible.
    """
    return _python_repl.run(code)


@tool
def read_file(file_path: str) -> str:
    """Read the contents of a file.

    Use this to read CSV data files, task descriptions, or other text files.
    """
    return Path(file_path).read_text()
```

- [ ] **Step 3: Create baseline/react/agent.py**

```python
"""React baseline agent implementing the DataScienceAgent protocol."""

from pathlib import Path
from typing import Any

from langchain.agents import create_agent
from loguru import logger

from statigent.models import get_model

from .tools import python_repl, read_file

_SYSTEM_PROMPT = """You are a data science assistant. You can:
1. Read data files using the read_file tool
2. Execute Python code using the python_repl tool to analyze data

When answering questions:
- Read the provided data files first
- Write Python code to compute the answer
- Always print the final answer in the required format
- If the question specifies an output format like @answer_name[value], follow it exactly
- Pay attention to constraints (rounding, specific libraries, etc.)
- For numerical answers, make sure to print them clearly

When doing modeling tasks:
- Read the training and test data
- Build a model using Python
- Generate predictions and save them to the specified output path as CSV
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
        self, prompt: str, *, files: list[Path] | None = None
    ) -> str:
        """Run agent on an analysis task, return text response."""
        file_info = ""
        if files:
            file_info = "\n\nAvailable data files:\n" + "\n".join(
                f"- {f}" for f in files
            )

        result = self.agent.invoke({
            "messages": [{"role": "user", "content": prompt + file_info}]
        })
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
    ) -> Path:
        """Run agent on a modeling task, return path to prediction CSV."""
        output_path = train_path.parent / "submission.csv"
        full_prompt = (
            f"{prompt}\n\n"
            f"Training data: {train_path}\n"
            f"Test data: {test_path}\n"
            f"Sample submission: {sample_submission_path}\n"
            f"Save your predictions to: {output_path}\n\n"
            f"Read the training data, build a model, generate predictions for the test data, "
            f"and save them as a CSV file matching the sample submission format to {output_path}."
        )

        self.agent.invoke({
            "messages": [{"role": "user", "content": full_prompt}]
        })

        if not output_path.exists():
            logger.warning("Submission file not created at {}", output_path)
        return output_path
```

- [ ] **Step 4: Verify imports work**

Run: `uv run python -c "from baseline.react.agent import ReactBaselineAgent; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Run linter**

Run: `uv run ruff check baseline/react/`
Expected: No errors (may need to adjust if baseline is outside `src/` for ruff config)

- [ ] **Step 6: Commit**

```bash
git add baseline/react/__init__.py baseline/react/agent.py baseline/react/tools.py
git commit -m "feat: add react baseline agent with PythonREPL and file read tools"
```

---

### Task 9: Minimal DABench Validation

**Files:**
- Create: `baseline/react/run_dabench_mini.py`

- [ ] **Step 1: Create minimal validation script**

Create `baseline/react/run_dabench_mini.py`:

```python
"""Minimal DABench validation: run baseline agent on a few questions."""

from loguru import logger
from rich.console import Console
from rich.table import Table

from statigent.benchmarks.dabench import DABenchAdapter
from baseline.react.agent import ReactBaselineAgent


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

- [ ] **Step 2: Run the validation script (requires DEEPSEEK_API_KEY env var)**

Run: `uv run python baseline/react/run_dabench_mini.py`
Expected: Script runs through prepare -> run -> evaluate pipeline. Actual correctness depends on the model's answers, but the pipeline itself should complete without errors.

- [ ] **Step 3: Commit**

```bash
git add baseline/react/run_dabench_mini.py
git commit -m "feat: add minimal DABench validation script for baseline react agent"
```

---

### Task 10: Evaluation Guide Documentation

**Files:**
- Create: `docs/how_to_eval.md`

- [ ] **Step 1: Create how_to_eval.md**

Create `docs/how_to_eval.md`:

```markdown
# How to Evaluate Your Agent

This guide explains how to use the statigent benchmark evaluation layer to evaluate data science agents.

## Quick Start

```python
from statigent.benchmarks import run_benchmark, get_benchmark, list_benchmarks
from baseline.react.agent import ReactBaselineAgent

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
```

- [ ] **Step 2: Verify markdown renders correctly**

Run: `head -5 docs/how_to_eval.md`
Expected: File header visible

- [ ] **Step 3: Commit**

```bash
git add docs/how_to_eval.md
git commit -m "docs: add evaluation guide (how_to_eval.md)"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| Package structure `src/statigent/benchmarks/` | Task 2 |
| `ScoreResult` + `EvalResult` dataclasses | Task 2 |
| `Evaluator` ABC | Task 2 |
| `BenchmarkAdapter` ABC with prepare/run/evaluate/execute | Task 2 |
| `DataScienceAgent` Protocol with `run_analysis_for_eval` / `run_modeling_for_eval` | Task 2 |
| `ExactMatchEvaluator` | Task 3 |
| `LLMJudgeEvaluator` using `statigent.models` | Task 3 |
| `MetricEvaluator` | Not implemented (stub only — DSBench DM uses per-competition scripts, MLE-Bench uses mlebench CLI; no generic implementation needed yet) |
| `ReformatEvaluator` using `statigent.models` | Task 3 |
| DABenchAdapter | Task 4 |
| DSBenchAdapter (DA + DM) | Task 5 |
| MLEBenchAdapter | Task 6 |
| LLM-as-judge rewrite (DABench reformat) | Task 3 (ReformatEvaluator) |
| LLM-as-judge rewrite (DSBench DA judge) | Task 3 (LLMJudgeEvaluator) + Task 5 |
| LLM-as-judge rewrite (MLE-Bench violation) | Task 6 (detect_violations stub) |
| Evaluation output to `evaluations/{agent_name}-{model_name}-{benchmark_name}-{timestamp}/` | Not implemented in this plan — deferred to a follow-up since the spec describes the structure but the adapter methods currently return EvalResult directly |
| `baseline/react/` agent | Task 8 |
| `create_agent` (not deprecated `create_react_agent`) | Task 8 |
| PythonREPLTool + file read tools | Task 8 |
| Minimal DABench validation | Task 9 |
| `benchmarks/data/` in `.gitignore` | Task 1 |
| `StatigentBenchmarkError` | Task 1 |
| Package public API | Task 7 |
| Evaluation guide documentation (`docs/how_to_eval.md`) | Task 10 |

### Placeholder Scan

- `MetricEvaluator`: Not implemented as a standalone class. DSBench DM evaluation raises `StatigentBenchmarkError` with "not yet implemented". MLE-Bench uses `mlebench grade-sample` CLI directly. This is intentional — the two benchmarks have completely different metric pipelines and a generic MetricEvaluator would be an over-abstraction at this point.
- `detect_violations`: Stub implementation in MLEBenchAdapter. Full implementation requires reading MLE-Bench's prompt templates and log files — deferred.
- Evaluation output directory structure: Not wired up in this plan. The adapters currently return `EvalResult` objects. A follow-up task should add result persistence.

### Type Consistency

- `DataScienceAgent` protocol methods match across all usages in adapter `run()` methods
- `EvalResult.from_score_result()` consistently used in all adapter `evaluate()` methods
- `_read_jsonl` helper defined in `dabench.py` — could be shared but each adapter has different data loading needs
