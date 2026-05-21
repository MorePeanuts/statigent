# Data Science Agent Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first architecture skeleton for Statigent's input layer, notebook execution abstraction, LLM-backed exploration layer, output layer, and benchmark-compatible agent wrapper.

**Architecture:** Add focused modules under `src/statigent/` with Pydantic boundary schemas, deterministic input profiling, a notebook kernel protocol with fake and Docker-backed implementations, explicit Python orchestration for Inspector/Reviewer/Coder/Debugger, and an agent wrapper that preserves `DataScienceAgent`. The implementation uses LangChain only for model construction and structured LLM calls, not graph-level orchestration.

**Tech Stack:** Python 3.12, Pydantic, LangChain chat model structured output, pandas for tabular profiling, existing `statigent.models`, existing `DockerSandbox`, pytest, ruff, mypy strict.

---

## Scope Check

The design spans several subsystems, but they are tightly coupled by one executable skeleton. This plan keeps the first implementation cohesive by sequencing shared schemas first, then fake-testable units, then concrete integrations. Full data modeling and deep commercial analysis remain out of scope and return explicit unsupported outputs.

## File Structure

- Create `src/statigent/schemas.py`: shared Pydantic models and enums for task briefs, dataset profiles, notebook cells, exploration actions, reports, artifacts, outputs, budgets, and trace events.
- Create `src/statigent/input/__init__.py`: package exports.
- Create `src/statigent/input/profiler.py`: path expansion, archive extraction, tabular file detection, and lightweight table profiling.
- Create `src/statigent/input/planner.py`: task brief generation from prompt, instructions, and dataset profile using LangChain structured output with deterministic fallback.
- Create `src/statigent/notebook/__init__.py`: package exports.
- Create `src/statigent/notebook/base.py`: notebook kernel protocol and execution context.
- Create `src/statigent/notebook/fake.py`: fake kernel for orchestrator tests.
- Create `src/statigent/notebook/docker.py`: Docker-backed incremental Python kernel.
- Create `src/statigent/exploration/__init__.py`: package exports.
- Create `src/statigent/exploration/actors.py`: LLM role wrappers for Inspector, Reviewer, Coder, and Debugger.
- Create `src/statigent/exploration/orchestrator.py`: explicit exploration loop, budget accounting, debug retry, and final review.
- Create `src/statigent/output/__init__.py`: package exports.
- Create `src/statigent/output/renderer.py`: output bundle rendering by `output_type` and unsupported task handling.
- Create `src/statigent/agents/__init__.py`: package exports.
- Create `src/statigent/agents/data_science.py`: new benchmark-compatible agent wrapper.
- Modify `src/statigent/errors.py`: add input, notebook, exploration, and output error subclasses.
- Modify `pyproject.toml`: add direct runtime dependency on `pydantic` using `uv add pydantic` during implementation, and ensure table profiling dependencies are available through the existing `datascience` group.
- Create tests under `tests/input/`, `tests/notebook/`, `tests/exploration/`, `tests/output/`, and `tests/agents/`.

## Implementation Tasks

### Task 1: Add Core Schemas

**Files:**
- Create: `src/statigent/schemas.py`
- Test: `tests/test_schemas.py`

- [ ] **Step 1: Add direct Pydantic dependency**

Run:

```bash
uv add pydantic
```

Expected: `pyproject.toml` gains a `pydantic` dependency and `uv.lock` updates.

- [ ] **Step 2: Write failing schema tests**

Create `tests/test_schemas.py`:

```python
from pathlib import Path

import pytest
from pydantic import ValidationError

from statigent.schemas import (
    ArtifactRef,
    Budget,
    Complexity,
    DatasetProfile,
    ExplorationAction,
    ExplorationActionKind,
    InputFileInfo,
    OutputBundle,
    OutputStatus,
    OutputType,
    TableProfile,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


def test_budget_for_complexity_simple_returns_small_limits() -> None:
    budget = budget_for_complexity(Complexity.SIMPLE)

    assert budget.max_rounds == 2
    assert budget.max_code_cells == 4
    assert budget.max_debug_attempts == 1


def test_task_brief_supports_deep_analysis() -> None:
    brief = TaskBrief(
        task_type=TaskType.DEEP_ANALYSIS,
        objective="Create an executive sales report",
        output_type=OutputType.REPORT,
        requirements=["Use business language"],
        data_context="sales.csv has daily revenue",
        complexity=Complexity.COMPLEX,
        budgets=budget_for_complexity(Complexity.COMPLEX),
    )

    assert brief.task_type is TaskType.DEEP_ANALYSIS
    assert brief.budgets.max_rounds == 8


def test_custom_action_requires_rationale_expected_evidence_and_risk_notes() -> None:
    with pytest.raises(ValidationError):
        ExplorationAction(
            kind=ExplorationActionKind.CUSTOM_ANALYSIS,
            title="Try unusual segmentation",
            description="Cluster stores by seasonality",
        )

    action = ExplorationAction(
        kind=ExplorationActionKind.CUSTOM_ANALYSIS,
        title="Try unusual segmentation",
        description="Cluster stores by seasonality",
        rationale="The prompt asks for hidden patterns",
        expected_evidence="A compact segment summary",
        risk_notes="May overfit noisy history",
    )

    assert action.kind is ExplorationActionKind.CUSTOM_ANALYSIS


def test_dataset_profile_records_table_and_non_table_files(tmp_path: Path) -> None:
    profile = DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=tmp_path / "sales.csv",
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=12,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=tmp_path / "sales.csv",
                relative_path="sales.csv",
                rows=2,
                columns=2,
                column_names=["date", "revenue"],
                dtypes={"date": "object", "revenue": "int64"},
                missing_rates={"date": 0.0, "revenue": 0.0},
                unique_counts={"date": 2, "revenue": 2},
                numeric_summaries={"revenue": {"mean": 15.0}},
                likely_time_columns=["date"],
                likely_categorical_columns=[],
                sample_rows=[{"date": "2026-01-01", "revenue": 10}],
                warnings=[],
            )
        ],
        warnings=[],
    )

    assert profile.tables[0].rows == 2
    assert "sales.csv" in profile.compact_summary()


def test_output_bundle_has_status_content_and_artifacts(tmp_path: Path) -> None:
    bundle = OutputBundle(
        status=OutputStatus.SUCCESS,
        output_type=OutputType.FILE,
        content="Generated cleaned data",
        artifacts=[
            ArtifactRef(
                name="clean.csv",
                path=tmp_path / "clean.csv",
                kind="table",
                description="Cleaned table",
            )
        ],
        warnings=[],
        trace_summary="1 cell executed",
    )

    assert bundle.artifacts[0].name == "clean.csv"
```

- [ ] **Step 3: Run schema tests to verify failure**

Run:

```bash
uv run pytest tests/test_schemas.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.schemas'`.

- [ ] **Step 4: Implement schemas**

Create `src/statigent/schemas.py`:

```python
from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class TaskType(StrEnum):
    DATA_ANALYSIS = "data_analysis"
    DATA_MODELING = "data_modeling"
    DEEP_ANALYSIS = "deep_analysis"
    UNKNOWN = "unknown"


class OutputType(StrEnum):
    ANSWER = "answer"
    REPORT = "report"
    FILE = "file"


class Complexity(StrEnum):
    SIMPLE = "simple"
    MODERATE = "moderate"
    COMPLEX = "complex"


class OutputStatus(StrEnum):
    SUCCESS = "success"
    PARTIAL = "partial"
    UNSUPPORTED = "unsupported"
    ERROR = "error"


class ExplorationActionKind(StrEnum):
    INSPECT_SCHEMA = "inspect_schema"
    PROFILE_MISSINGNESS = "profile_missingness"
    SUMMARIZE_NUMERIC = "summarize_numeric"
    SUMMARIZE_CATEGORICAL = "summarize_categorical"
    ANALYZE_TIME_TREND = "analyze_time_trend"
    ANALYZE_GROUP_COMPARISON = "analyze_group_comparison"
    ANALYZE_CORRELATION = "analyze_correlation"
    DETECT_OUTLIERS = "detect_outliers"
    VALIDATE_DATA_QUALITY = "validate_data_quality"
    CREATE_VISUALIZATION = "create_visualization"
    ANSWER_SPECIFIC_QUESTION = "answer_specific_question"
    CUSTOM_ANALYSIS = "custom_analysis"


class Budget(BaseModel):
    max_rounds: int = Field(ge=1)
    max_code_cells: int = Field(ge=1)
    max_debug_attempts: int = Field(ge=0)
    timeout_seconds: int = Field(ge=1)


def budget_for_complexity(complexity: Complexity) -> Budget:
    if complexity is Complexity.SIMPLE:
        return Budget(
            max_rounds=2,
            max_code_cells=4,
            max_debug_attempts=1,
            timeout_seconds=120,
        )
    if complexity is Complexity.MODERATE:
        return Budget(
            max_rounds=5,
            max_code_cells=10,
            max_debug_attempts=2,
            timeout_seconds=300,
        )
    return Budget(
        max_rounds=8,
        max_code_cells=18,
        max_debug_attempts=3,
        timeout_seconds=600,
    )


class InputFileInfo(BaseModel):
    path: Path
    relative_path: str
    suffix: str
    size_bytes: int = Field(ge=0)
    is_tabular: bool
    warnings: list[str] = Field(default_factory=list)


class TableProfile(BaseModel):
    path: Path
    relative_path: str
    rows: int = Field(ge=0)
    columns: int = Field(ge=0)
    column_names: list[str]
    dtypes: dict[str, str]
    missing_rates: dict[str, float]
    unique_counts: dict[str, int]
    numeric_summaries: dict[str, dict[str, float]]
    likely_time_columns: list[str]
    likely_categorical_columns: list[str]
    sample_rows: list[dict[str, object]]
    warnings: list[str] = Field(default_factory=list)


class DatasetProfile(BaseModel):
    root: Path
    files: list[InputFileInfo]
    tables: list[TableProfile]
    warnings: list[str] = Field(default_factory=list)

    def compact_summary(self) -> str:
        table_lines = [
            f"- {table.relative_path}: {table.rows} rows x {table.columns} columns; "
            f"columns={', '.join(table.column_names[:12])}"
            for table in self.tables
        ]
        if not table_lines:
            table_lines = ["- No tabular files were profiled."]
        warning_text = ""
        if self.warnings:
            warning_text = "\nWarnings:\n" + "\n".join(f"- {w}" for w in self.warnings)
        return "Tables:\n" + "\n".join(table_lines) + warning_text


class TaskBrief(BaseModel):
    task_type: TaskType
    objective: str
    output_type: OutputType
    requirements: list[str] = Field(default_factory=list)
    data_context: str
    complexity: Complexity
    budgets: Budget
    analysis_hints: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ExplorationAction(BaseModel):
    kind: ExplorationActionKind
    title: str
    description: str
    rationale: str = ""
    expected_evidence: str = ""
    risk_notes: str = ""

    @model_validator(mode="after")
    def validate_custom_action(self) -> "ExplorationAction":
        if self.kind is not ExplorationActionKind.CUSTOM_ANALYSIS:
            return self
        missing = [
            name
            for name in ("rationale", "expected_evidence", "risk_notes")
            if not getattr(self, name).strip()
        ]
        if missing:
            missing_text = ", ".join(missing)
            raise ValueError(f"custom_analysis requires: {missing_text}")
        return self


class ArtifactRef(BaseModel):
    name: str
    path: Path
    kind: str
    description: str = ""


class NotebookCellResult(BaseModel):
    cell_id: str
    code: str
    purpose: str
    stdout: str = ""
    stderr: str = ""
    exit_code: int
    duration_ms: int = Field(ge=0)
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    error_summary: str = ""

    @property
    def ok(self) -> bool:
        return self.exit_code == 0


class NotebookState(BaseModel):
    executed_cells: list[NotebookCellResult] = Field(default_factory=list)
    artifacts: list[ArtifactRef] = Field(default_factory=list)


class ReviewDecision(BaseModel):
    approved: bool
    reason: str
    revised_action: ExplorationAction | None = None


class CodeDraft(BaseModel):
    code: str
    purpose: str
    expected_observation: str


class DebugDecision(BaseModel):
    retry: bool
    code: str = ""
    reason: str


class FinalDraft(BaseModel):
    content: str
    evidence: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ExplorationStep(BaseModel):
    action: ExplorationAction
    review: ReviewDecision
    code: CodeDraft | None = None
    result: NotebookCellResult | None = None
    debug_attempts: int = 0


class ExplorationReport(BaseModel):
    status: Literal["success", "partial"]
    final_draft: FinalDraft
    steps: list[ExplorationStep]
    artifacts: list[ArtifactRef]
    warnings: list[str] = Field(default_factory=list)


class OutputBundle(BaseModel):
    status: OutputStatus
    output_type: OutputType
    content: str
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    trace_summary: str = ""


class TraceEvent(BaseModel):
    role: str
    content: str
    name: str = ""
    metadata: dict[str, object] = Field(default_factory=dict)
```

- [ ] **Step 5: Run schema tests**

Run:

```bash
uv run pytest tests/test_schemas.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit if commits are allowed**

Only run this step if the user has explicitly allowed commits:

```bash
git add pyproject.toml uv.lock src/statigent/schemas.py tests/test_schemas.py
git commit -m "feat: add data science agent schemas"
```

### Task 2: Add Domain Error Classes

**Files:**
- Modify: `src/statigent/errors.py`
- Test: `tests/test_errors.py`

- [ ] **Step 1: Extend failing error tests**

Append to `tests/test_errors.py`:

```python
from statigent.errors import (
    StatigentExplorationError,
    StatigentInputError,
    StatigentNotebookError,
    StatigentOutputError,
)


def test_layer_errors_inherit_from_statigent_error() -> None:
    errors = [
        StatigentInputError("bad input"),
        StatigentNotebookError("bad notebook"),
        StatigentExplorationError("bad exploration"),
        StatigentOutputError("bad output"),
    ]

    assert all(isinstance(err, StatigentError) for err in errors)
```

- [ ] **Step 2: Run error test to verify failure**

Run:

```bash
uv run pytest tests/test_errors.py -v
```

Expected: FAIL with import errors for the new error classes.

- [ ] **Step 3: Implement error subclasses**

Modify `src/statigent/errors.py`:

```python
class StatigentInputError(StatigentError):
    """Error raised by the input profiling and task brief layer."""


class StatigentNotebookError(StatigentError):
    """Error raised by notebook kernel execution."""


class StatigentExplorationError(StatigentError):
    """Error raised by the exploration orchestrator."""


class StatigentOutputError(StatigentError):
    """Error raised by output rendering."""
```

- [ ] **Step 4: Run error tests**

Run:

```bash
uv run pytest tests/test_errors.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit if commits are allowed**

```bash
git add src/statigent/errors.py tests/test_errors.py
git commit -m "feat: add agent layer errors"
```

### Task 3: Implement Input Profiling

**Files:**
- Create: `src/statigent/input/__init__.py`
- Create: `src/statigent/input/profiler.py`
- Test: `tests/input/test_profiler.py`

- [ ] **Step 1: Write failing profiler tests**

Create `tests/input/test_profiler.py`:

```python
import zipfile
from pathlib import Path

import pandas as pd
import pytest

from statigent.errors import StatigentInputError
from statigent.input import InputProfiler


def test_profile_csv_file_records_shape_and_columns(tmp_path: Path) -> None:
    data = tmp_path / "sales.csv"
    data.write_text("date,revenue,region\n2026-01-01,10,East\n2026-01-02,20,West\n")

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([data])

    assert profile.tables[0].rows == 2
    assert profile.tables[0].columns == 3
    assert profile.tables[0].likely_time_columns == ["date"]
    assert "region" in profile.tables[0].likely_categorical_columns


def test_profile_directory_scans_nested_tabular_files(tmp_path: Path) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "customers.tsv").write_text("id\tsegment\n1\tA\n2\tB\n")

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([tmp_path])

    assert any(table.relative_path.endswith("customers.tsv") for table in profile.tables)


def test_profile_zip_extracts_and_profiles_csv(tmp_path: Path) -> None:
    archive = tmp_path / "bundle.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("data/orders.csv", "id,total\n1,12.5\n2,8.0\n")

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([archive])

    assert profile.tables[0].relative_path.endswith("orders.csv")
    assert profile.tables[0].numeric_summaries["total"]["mean"] == 10.25


def test_profile_excel_and_parquet(tmp_path: Path) -> None:
    frame = pd.DataFrame({"id": [1, 2], "value": [3.0, 4.0]})
    excel_path = tmp_path / "data.xlsx"
    parquet_path = tmp_path / "data.parquet"
    frame.to_excel(excel_path, index=False)
    frame.to_parquet(parquet_path, index=False)

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths(
        [excel_path, parquet_path]
    )

    assert len(profile.tables) == 2
    assert {table.suffix for table in profile.files if table.is_tabular} == {
        ".xlsx",
        ".parquet",
    }


def test_profile_missing_path_raises_input_error(tmp_path: Path) -> None:
    profiler = InputProfiler(work_dir=tmp_path / "work")

    with pytest.raises(StatigentInputError):
        profiler.profile_paths([tmp_path / "missing.csv"])
```

- [ ] **Step 2: Run profiler tests to verify failure**

Run:

```bash
uv run pytest tests/input/test_profiler.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.input'`.

- [ ] **Step 3: Implement profiler exports**

Create `src/statigent/input/__init__.py`:

```python
from statigent.input.profiler import InputProfiler

__all__ = ["InputProfiler"]
```

- [ ] **Step 4: Implement profiler**

Create `src/statigent/input/profiler.py`:

```python
import shutil
import zipfile
from pathlib import Path

import pandas as pd

from statigent.errors import StatigentInputError
from statigent.schemas import DatasetProfile, InputFileInfo, TableProfile

_TABULAR_SUFFIXES = {".csv", ".tsv", ".xlsx", ".xls", ".parquet"}


class InputProfiler:
    def __init__(
        self,
        work_dir: Path,
        *,
        max_files: int = 200,
        max_file_bytes: int = 250_000_000,
        sample_rows: int = 5,
    ) -> None:
        self.work_dir = work_dir
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.sample_rows = sample_rows

    def profile_paths(self, paths: list[Path] | None) -> DatasetProfile:
        root = self.work_dir / "inputs"
        root.mkdir(parents=True, exist_ok=True)
        discovered = self._discover(paths or [], root)
        files: list[InputFileInfo] = []
        tables: list[TableProfile] = []
        warnings: list[str] = []

        for path in discovered[: self.max_files]:
            relative = path.name if path.is_absolute() else str(path)
            try:
                size = path.stat().st_size
            except OSError as err:
                raise StatigentInputError(f"Cannot stat input file {path}: {err}") from err
            suffix = path.suffix.lower()
            is_tabular = suffix in _TABULAR_SUFFIXES
            info = InputFileInfo(
                path=path,
                relative_path=relative,
                suffix=suffix,
                size_bytes=size,
                is_tabular=is_tabular,
            )
            files.append(info)
            if size > self.max_file_bytes:
                warning = f"Skipped {path}: file exceeds {self.max_file_bytes} bytes"
                info.warnings.append(warning)
                warnings.append(warning)
                continue
            if is_tabular:
                try:
                    tables.append(self._profile_table(path, relative))
                except (OSError, ValueError, ImportError) as err:
                    warning = f"Failed to profile {path}: {err}"
                    info.warnings.append(warning)
                    warnings.append(warning)

        if len(discovered) > self.max_files:
            warnings.append(
                f"Scanned first {self.max_files} files out of {len(discovered)} discovered"
            )

        return DatasetProfile(root=root, files=files, tables=tables, warnings=warnings)

    def _discover(self, paths: list[Path], root: Path) -> list[Path]:
        discovered: list[Path] = []
        for raw_path in paths:
            path = raw_path.expanduser().resolve()
            if not path.exists():
                raise StatigentInputError(f"Input path does not exist: {path}")
            if path.is_dir():
                discovered.extend(p for p in sorted(path.rglob("*")) if p.is_file())
            elif path.suffix.lower() == ".zip":
                extract_dir = root / path.stem
                if extract_dir.exists():
                    shutil.rmtree(extract_dir)
                extract_dir.mkdir(parents=True, exist_ok=True)
                self._extract_zip(path, extract_dir)
                discovered.extend(p for p in sorted(extract_dir.rglob("*")) if p.is_file())
            else:
                discovered.append(path)
        return discovered

    def _extract_zip(self, path: Path, dest: Path) -> None:
        try:
            with zipfile.ZipFile(path) as zf:
                dest_resolved = dest.resolve()
                for member in zf.infolist():
                    target = (dest / member.filename).resolve()
                    if not str(target).startswith(str(dest_resolved)):
                        raise StatigentInputError(
                            f"Archive member escapes extraction directory: {member.filename}"
                        )
                zf.extractall(dest)
        except zipfile.BadZipFile as err:
            raise StatigentInputError(f"Invalid zip archive {path}: {err}") from err

    def _profile_table(self, path: Path, relative_path: str) -> TableProfile:
        frame = self._read_table(path)
        numeric = frame.select_dtypes(include="number")
        numeric_summaries = {
            column: {
                key: float(value)
                for key, value in numeric[column].describe().to_dict().items()
                if pd.notna(value)
            }
            for column in numeric.columns
        }
        dtypes = {column: str(dtype) for column, dtype in frame.dtypes.items()}
        missing_rates = {
            column: float(rate) for column, rate in frame.isna().mean().to_dict().items()
        }
        unique_counts = {
            column: int(count)
            for column, count in frame.nunique(dropna=True).to_dict().items()
        }
        likely_time_columns = [
            column
            for column in frame.columns
            if "date" in column.lower() or "time" in column.lower()
        ]
        likely_categorical_columns = [
            column
            for column in frame.columns
            if column not in numeric.columns and column not in likely_time_columns
        ]
        sample_records = frame.head(self.sample_rows).astype(object).to_dict("records")
        return TableProfile(
            path=path,
            relative_path=relative_path,
            rows=len(frame),
            columns=len(frame.columns),
            column_names=[str(column) for column in frame.columns],
            dtypes=dtypes,
            missing_rates=missing_rates,
            unique_counts=unique_counts,
            numeric_summaries=numeric_summaries,
            likely_time_columns=likely_time_columns,
            likely_categorical_columns=likely_categorical_columns,
            sample_rows=sample_records,
            warnings=[],
        )

    def _read_table(self, path: Path) -> pd.DataFrame:
        suffix = path.suffix.lower()
        if suffix == ".csv":
            return pd.read_csv(path)
        if suffix == ".tsv":
            return pd.read_csv(path, sep="\t")
        if suffix in {".xlsx", ".xls"}:
            return pd.read_excel(path)
        if suffix == ".parquet":
            return pd.read_parquet(path)
        raise StatigentInputError(f"Unsupported tabular file type: {path}")
```

- [ ] **Step 5: Fix test suffix assertion**

If mypy or tests flag `table.suffix` access in `test_profile_excel_and_parquet`, change the assertion to:

```python
assert {file.suffix for file in profile.files if file.is_tabular} == {
    ".xlsx",
    ".parquet",
}
```

- [ ] **Step 6: Run profiler tests**

Run:

```bash
uv run pytest tests/input/test_profiler.py -v
```

Expected: PASS. If Excel or Parquet engines are unavailable, add the required package with `uv add --group datascience openpyxl pyarrow` instead of importing them manually.

- [ ] **Step 7: Commit if commits are allowed**

```bash
git add pyproject.toml uv.lock src/statigent/input tests/input/test_profiler.py
git commit -m "feat: add input profiling"
```

### Task 4: Implement Task Brief Generation

**Files:**
- Create: `src/statigent/input/planner.py`
- Modify: `src/statigent/input/__init__.py`
- Test: `tests/input/test_planner.py`

- [ ] **Step 1: Write failing planner tests**

Create `tests/input/test_planner.py`:

```python
from pathlib import Path
from typing import Any

from langchain.messages import AIMessage

from statigent.input import TaskBriefPlanner
from statigent.schemas import (
    Budget,
    Complexity,
    DatasetProfile,
    InputFileInfo,
    OutputType,
    TableProfile,
    TaskBrief,
    TaskType,
)


class FakeStructuredModel:
    def __init__(self, result: TaskBrief | Exception) -> None:
        self.result = result

    def invoke(self, _messages: list[dict[str, str]]) -> TaskBrief:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class FakeModel:
    def __init__(self, result: TaskBrief | Exception) -> None:
        self.result = result

    def with_structured_output(self, _schema: type[TaskBrief]) -> FakeStructuredModel:
        return FakeStructuredModel(self.result)


def make_profile(tmp_path: Path) -> DatasetProfile:
    table = tmp_path / "sales.csv"
    return DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=table,
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=10,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=table,
                relative_path="sales.csv",
                rows=2,
                columns=2,
                column_names=["date", "revenue"],
                dtypes={"date": "object", "revenue": "int64"},
                missing_rates={"date": 0.0, "revenue": 0.0},
                unique_counts={"date": 2, "revenue": 2},
                numeric_summaries={"revenue": {"mean": 12.0}},
                likely_time_columns=["date"],
                likely_categorical_columns=[],
                sample_rows=[],
            )
        ],
        warnings=[],
    )


def test_planner_uses_structured_model_result(tmp_path: Path) -> None:
    expected = TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        objective="Analyze revenue trend",
        output_type=OutputType.REPORT,
        requirements=["Mention trend"],
        data_context="sales.csv",
        complexity=Complexity.MODERATE,
        budgets=Budget(
            max_rounds=5,
            max_code_cells=10,
            max_debug_attempts=2,
            timeout_seconds=300,
        ),
    )
    planner = TaskBriefPlanner(model=FakeModel(expected))

    brief = planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief == expected


def test_planner_fallback_detects_deep_analysis(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(RuntimeError("bad json")))

    brief = planner.create_brief(
        prompt="Create a deep business analysis report for sales executives",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.task_type is TaskType.DEEP_ANALYSIS
    assert brief.output_type is OutputType.REPORT
    assert brief.warnings


def test_planner_fallback_detects_modeling(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(RuntimeError("bad json")))

    brief = planner.create_brief(
        prompt="Build a predictive model and forecast next month's demand",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.task_type is TaskType.DATA_MODELING
```

- [ ] **Step 2: Run planner tests to verify failure**

Run:

```bash
uv run pytest tests/input/test_planner.py -v
```

Expected: FAIL with `ImportError: cannot import name 'TaskBriefPlanner'`.

- [ ] **Step 3: Implement planner**

Create `src/statigent/input/planner.py`:

```python
from langchain.chat_models import BaseChatModel

from statigent.schemas import (
    Complexity,
    DatasetProfile,
    OutputType,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


class TaskBriefPlanner:
    def __init__(self, model: BaseChatModel) -> None:
        self.model = model

    def create_brief(
        self,
        *,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief:
        messages = [
            {
                "role": "system",
                "content": (
                    "You create semi-structured task briefs for data science "
                    "analysis. Classify task_type as data_analysis, "
                    "data_modeling, deep_analysis, or unknown. Use deep_analysis "
                    "only for broad commercial or executive business reports."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Prompt:\n{prompt}\n\n"
                    f"Task instructions:\n{task_instructions}\n\n"
                    f"Dataset profile:\n{profile.compact_summary()}"
                ),
            },
        ]
        try:
            structured = self.model.with_structured_output(TaskBrief)
            return structured.invoke(messages)
        except Exception as err:
            return self._fallback(prompt, profile, str(err))

    def _fallback(
        self,
        prompt: str,
        profile: DatasetProfile,
        reason: str,
    ) -> TaskBrief:
        lowered = prompt.lower()
        task_type = TaskType.DATA_ANALYSIS
        output_type = OutputType.ANSWER
        complexity = Complexity.SIMPLE

        if any(word in lowered for word in ("predict", "forecast", "model")):
            task_type = TaskType.DATA_MODELING
            output_type = OutputType.FILE
            complexity = Complexity.COMPLEX
        elif "deep" in lowered and any(
            word in lowered for word in ("business", "commercial", "executive", "report")
        ):
            task_type = TaskType.DEEP_ANALYSIS
            output_type = OutputType.REPORT
            complexity = Complexity.COMPLEX
        elif "report" in lowered or "analysis" in lowered:
            output_type = OutputType.REPORT
            complexity = Complexity.MODERATE

        return TaskBrief(
            task_type=task_type,
            objective=prompt.strip() or "Analyze the provided data",
            output_type=output_type,
            requirements=[],
            data_context=profile.compact_summary(),
            complexity=complexity,
            budgets=budget_for_complexity(complexity),
            analysis_hints=[],
            warnings=[f"LLM task brief parsing failed; used fallback: {reason}"],
        )
```

- [ ] **Step 4: Export planner**

Modify `src/statigent/input/__init__.py`:

```python
from statigent.input.planner import TaskBriefPlanner
from statigent.input.profiler import InputProfiler

__all__ = ["InputProfiler", "TaskBriefPlanner"]
```

- [ ] **Step 5: Run planner tests**

Run:

```bash
uv run pytest tests/input/test_planner.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit if commits are allowed**

```bash
git add src/statigent/input tests/input/test_planner.py
git commit -m "feat: add task brief planner"
```

### Task 5: Add Notebook Kernel Protocol and Fake Kernel

**Files:**
- Create: `src/statigent/notebook/__init__.py`
- Create: `src/statigent/notebook/base.py`
- Create: `src/statigent/notebook/fake.py`
- Test: `tests/notebook/test_fake_kernel.py`

- [ ] **Step 1: Write failing fake kernel tests**

Create `tests/notebook/test_fake_kernel.py`:

```python
from pathlib import Path

from statigent.notebook import FakeNotebookKernel, NotebookContext


def test_fake_kernel_executes_queued_results(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="rows=2\n", exit_code=0)
    kernel.start(
        NotebookContext(input_paths=[tmp_path], work_dir=tmp_path / "work")
    )

    result = kernel.execute_cell("print('rows=2')", "count rows")

    assert result.stdout == "rows=2\n"
    assert result.purpose == "count rows"
    assert kernel.snapshot().executed_cells[0].code == "print('rows=2')"


def test_fake_kernel_records_artifacts(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(
        NotebookContext(input_paths=[tmp_path], work_dir=tmp_path / "work")
    )

    artifact = kernel.write_artifact("summary.md", "content", "report")

    assert artifact.name == "summary.md"
    assert artifact in kernel.list_artifacts()


def test_fake_kernel_list_inputs(tmp_path: Path) -> None:
    data = tmp_path / "sales.csv"
    data.write_text("x\n1\n")
    kernel = FakeNotebookKernel()
    kernel.start(
        NotebookContext(input_paths=[data], work_dir=tmp_path / "work")
    )

    assert kernel.list_inputs() == [data]
```

- [ ] **Step 2: Run fake kernel tests to verify failure**

Run:

```bash
uv run pytest tests/notebook/test_fake_kernel.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.notebook'`.

- [ ] **Step 3: Implement notebook base**

Create `src/statigent/notebook/base.py`:

```python
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, Field

from statigent.schemas import ArtifactRef, NotebookCellResult, NotebookState


class NotebookContext(BaseModel):
    input_paths: list[Path]
    work_dir: Path
    timeout_seconds: int = Field(default=600, ge=1)


class FileReadResult(BaseModel):
    path: Path
    content: str
    truncated: bool = False


class NotebookKernel(Protocol):
    def start(self, context: NotebookContext) -> None: ...

    def close(self) -> None: ...

    def execute_cell(self, code: str, purpose: str) -> NotebookCellResult: ...

    def read_file(
        self,
        path: Path,
        *,
        max_bytes: int = 100_000,
        max_rows: int = 0,
    ) -> FileReadResult: ...

    def write_artifact(self, name: str, content: str, kind: str) -> ArtifactRef: ...

    def list_inputs(self) -> list[Path]: ...

    def list_artifacts(self) -> list[ArtifactRef]: ...

    def snapshot(self) -> NotebookState: ...
```

- [ ] **Step 4: Implement fake kernel**

Create `src/statigent/notebook/fake.py`:

```python
from pathlib import Path

from statigent.errors import StatigentNotebookError
from statigent.notebook.base import FileReadResult, NotebookContext
from statigent.schemas import ArtifactRef, NotebookCellResult, NotebookState


class FakeNotebookKernel:
    def __init__(self) -> None:
        self._context: NotebookContext | None = None
        self._queued: list[tuple[str, str, int]] = []
        self._state = NotebookState()

    def queue_result(self, stdout: str = "", stderr: str = "", exit_code: int = 0) -> None:
        self._queued.append((stdout, stderr, exit_code))

    def start(self, context: NotebookContext) -> None:
        self._context = context
        context.work_dir.mkdir(parents=True, exist_ok=True)

    def close(self) -> None:
        self._context = None

    def execute_cell(self, code: str, purpose: str) -> NotebookCellResult:
        if self._context is None:
            raise StatigentNotebookError("Fake notebook kernel has not been started")
        stdout, stderr, exit_code = self._queued.pop(0) if self._queued else ("", "", 0)
        result = NotebookCellResult(
            cell_id=f"cell-{len(self._state.executed_cells) + 1}",
            code=code,
            purpose=purpose,
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=0,
            artifacts=[],
            error_summary=stderr if exit_code else "",
        )
        self._state.executed_cells.append(result)
        return result

    def read_file(
        self,
        path: Path,
        *,
        max_bytes: int = 100_000,
        max_rows: int = 0,
    ) -> FileReadResult:
        content = path.read_text()
        if max_rows > 0:
            content = "\n".join(content.splitlines()[:max_rows])
        truncated = len(content.encode()) > max_bytes
        if truncated:
            content = content.encode()[:max_bytes].decode(errors="replace")
        return FileReadResult(path=path, content=content, truncated=truncated)

    def write_artifact(self, name: str, content: str, kind: str) -> ArtifactRef:
        if self._context is None:
            raise StatigentNotebookError("Fake notebook kernel has not been started")
        path = self._context.work_dir / "artifacts" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        artifact = ArtifactRef(name=name, path=path, kind=kind)
        self._state.artifacts.append(artifact)
        return artifact

    def list_inputs(self) -> list[Path]:
        if self._context is None:
            return []
        return self._context.input_paths

    def list_artifacts(self) -> list[ArtifactRef]:
        return self._state.artifacts

    def snapshot(self) -> NotebookState:
        return self._state
```

- [ ] **Step 5: Export notebook types**

Create `src/statigent/notebook/__init__.py`:

```python
from statigent.notebook.base import FileReadResult, NotebookContext, NotebookKernel
from statigent.notebook.fake import FakeNotebookKernel

__all__ = [
    "FakeNotebookKernel",
    "FileReadResult",
    "NotebookContext",
    "NotebookKernel",
]
```

- [ ] **Step 6: Run fake kernel tests**

Run:

```bash
uv run pytest tests/notebook/test_fake_kernel.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit if commits are allowed**

```bash
git add src/statigent/notebook tests/notebook/test_fake_kernel.py
git commit -m "feat: add notebook kernel protocol"
```

### Task 6: Implement Docker Notebook Kernel

**Files:**
- Create: `src/statigent/notebook/docker.py`
- Modify: `src/statigent/notebook/__init__.py`
- Test: `tests/notebook/test_docker_kernel.py`

- [ ] **Step 1: Write Docker kernel unit tests with mocked sandbox**

Create `tests/notebook/test_docker_kernel.py`:

```python
from pathlib import Path
from unittest.mock import MagicMock, patch

from statigent.notebook import DockerNotebookKernel, NotebookContext


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_starts_sandbox_with_mounts(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    mock_sandbox_class.return_value = sandbox
    data = tmp_path / "sales.csv"
    data.write_text("x\n1\n")
    kernel = DockerNotebookKernel(image="image", network=False)

    kernel.start(NotebookContext(input_paths=[data], work_dir=tmp_path / "work"))

    sandbox.start.assert_called_once()
    mounts = sandbox.start.call_args[0][0]
    assert any(mount[0] == data.parent for mount in mounts)


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_execute_cell_wraps_incremental_driver(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    sandbox.exec.return_value = '{"stdout": "2\\n", "stderr": "", "exit_code": 0}'
    mock_sandbox_class.return_value = sandbox
    kernel = DockerNotebookKernel(image="image", network=False)
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))

    result = kernel.execute_cell("x = 1 + 1\nprint(x)", "compute")

    assert result.stdout == "2\n"
    assert result.exit_code == 0
    assert "statigent_notebook_driver.py" in sandbox.exec.call_args[0][0]


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_close_stops_sandbox(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    mock_sandbox_class.return_value = sandbox
    kernel = DockerNotebookKernel(image="image", network=False)
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))

    kernel.close()

    sandbox.stop.assert_called_once()
```

- [ ] **Step 2: Run Docker kernel tests to verify failure**

Run:

```bash
uv run pytest tests/notebook/test_docker_kernel.py -v
```

Expected: FAIL with `ImportError: cannot import name 'DockerNotebookKernel'`.

- [ ] **Step 3: Implement Docker kernel**

Create `src/statigent/notebook/docker.py`:

```python
import base64
import json
import time
from pathlib import Path

from statigent.errors import StatigentNotebookError
from statigent.notebook.base import FileReadResult, NotebookContext
from statigent.sandbox.docker import DockerSandbox
from statigent.schemas import ArtifactRef, NotebookCellResult, NotebookState

_DRIVER = r'''
import base64
import contextlib
import io
import json
import traceback

STATE = {}

def run_cell(encoded):
    code = base64.b64decode(encoded.encode()).decode()
    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = 0
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            exec(code, STATE, STATE)
        except Exception:
            exit_code = 1
            traceback.print_exc(file=stderr)
    print(json.dumps({
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "exit_code": exit_code,
    }))
'''


class DockerNotebookKernel:
    def __init__(
        self,
        *,
        image: str = "statigent/ds-sandbox",
        network: bool = False,
    ) -> None:
        self.image = image
        self.network = network
        self._sandbox: DockerSandbox | None = None
        self._context: NotebookContext | None = None
        self._state = NotebookState()

    def start(self, context: NotebookContext) -> None:
        self._context = context
        context.work_dir.mkdir(parents=True, exist_ok=True)
        self._sandbox = DockerSandbox(
            image=self.image,
            network=self.network,
            timeout=context.timeout_seconds,
        )
        dirs = {
            path.resolve() if path.is_dir() else path.resolve().parent
            for path in context.input_paths
        }
        mounts = [(path, str(path), True) for path in sorted(dirs)]
        self._sandbox.start(mounts)
        encoded_driver = base64.b64encode(_DRIVER.encode()).decode()
        self._sandbox.exec(
            f"echo {encoded_driver} | base64 -d > /tmp/statigent_notebook_driver.py"
        )

    def close(self) -> None:
        if self._sandbox is not None:
            self._sandbox.stop()
        self._sandbox = None
        self._context = None

    def execute_cell(self, code: str, purpose: str) -> NotebookCellResult:
        sandbox = self._require_sandbox()
        encoded = base64.b64encode(code.encode()).decode()
        command = (
            "python - <<'PY'\n"
            "import importlib.util\n"
            "spec = importlib.util.spec_from_file_location("
            "'driver', '/tmp/statigent_notebook_driver.py')\n"
            "driver = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(driver)\n"
            f"driver.run_cell('{encoded}')\n"
            "PY"
        )
        start = time.perf_counter()
        raw = sandbox.exec(command)
        duration_ms = int((time.perf_counter() - start) * 1000)
        try:
            payload = json.loads(raw.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError) as err:
            raise StatigentNotebookError(f"Invalid notebook execution output: {raw}") from err
        result = NotebookCellResult(
            cell_id=f"cell-{len(self._state.executed_cells) + 1}",
            code=code,
            purpose=purpose,
            stdout=str(payload.get("stdout", "")),
            stderr=str(payload.get("stderr", "")),
            exit_code=int(payload.get("exit_code", 1)),
            duration_ms=duration_ms,
            artifacts=[],
            error_summary=str(payload.get("stderr", ""))[:500],
        )
        self._state.executed_cells.append(result)
        return result

    def read_file(
        self,
        path: Path,
        *,
        max_bytes: int = 100_000,
        max_rows: int = 0,
    ) -> FileReadResult:
        sandbox = self._require_sandbox()
        if max_rows > 0:
            raw = sandbox.exec(f"head -n {max_rows} {path}")
        else:
            raw = sandbox.exec(f"head -c {max_bytes + 1} {path}")
        truncated = len(raw.encode()) > max_bytes
        return FileReadResult(path=path, content=raw[:max_bytes], truncated=truncated)

    def write_artifact(self, name: str, content: str, kind: str) -> ArtifactRef:
        if self._context is None:
            raise StatigentNotebookError("Docker notebook kernel has not been started")
        path = self._context.work_dir / "artifacts" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        artifact = ArtifactRef(name=name, path=path, kind=kind)
        self._state.artifacts.append(artifact)
        return artifact

    def list_inputs(self) -> list[Path]:
        if self._context is None:
            return []
        return self._context.input_paths

    def list_artifacts(self) -> list[ArtifactRef]:
        return self._state.artifacts

    def snapshot(self) -> NotebookState:
        return self._state

    def _require_sandbox(self) -> DockerSandbox:
        if self._sandbox is None:
            raise StatigentNotebookError("Docker notebook kernel has not been started")
        return self._sandbox
```

- [ ] **Step 4: Export Docker kernel**

Modify `src/statigent/notebook/__init__.py`:

```python
from statigent.notebook.base import FileReadResult, NotebookContext, NotebookKernel
from statigent.notebook.docker import DockerNotebookKernel
from statigent.notebook.fake import FakeNotebookKernel

__all__ = [
    "DockerNotebookKernel",
    "FakeNotebookKernel",
    "FileReadResult",
    "NotebookContext",
    "NotebookKernel",
]
```

- [ ] **Step 5: Run Docker kernel tests**

Run:

```bash
uv run pytest tests/notebook/test_docker_kernel.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit if commits are allowed**

```bash
git add src/statigent/notebook tests/notebook/test_docker_kernel.py
git commit -m "feat: add docker notebook kernel"
```

### Task 7: Implement LLM Exploration Actors

**Files:**
- Create: `src/statigent/exploration/__init__.py`
- Create: `src/statigent/exploration/actors.py`
- Test: `tests/exploration/test_actors.py`

- [ ] **Step 1: Write actor tests with fake structured models**

Create `tests/exploration/test_actors.py`:

```python
from pathlib import Path

from statigent.exploration import Coder, Debugger, Inspector, Reviewer
from statigent.schemas import (
    CodeDraft,
    Complexity,
    DatasetProfile,
    DebugDecision,
    ExplorationAction,
    ExplorationActionKind,
    FinalDraft,
    InputFileInfo,
    OutputType,
    ReviewDecision,
    TableProfile,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


class FakeStructuredModel:
    def __init__(self, result: object) -> None:
        self.result = result

    def invoke(self, _messages: list[dict[str, str]]) -> object:
        return self.result


class FakeModel:
    def __init__(self, result: object) -> None:
        self.result = result

    def with_structured_output(self, _schema: type[object]) -> FakeStructuredModel:
        return FakeStructuredModel(self.result)


def make_brief() -> TaskBrief:
    return TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        objective="Find average revenue",
        output_type=OutputType.ANSWER,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.SIMPLE,
        budgets=budget_for_complexity(Complexity.SIMPLE),
    )


def make_profile(tmp_path: Path) -> DatasetProfile:
    path = tmp_path / "sales.csv"
    return DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=path,
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=10,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=path,
                relative_path="sales.csv",
                rows=2,
                columns=1,
                column_names=["revenue"],
                dtypes={"revenue": "int64"},
                missing_rates={"revenue": 0.0},
                unique_counts={"revenue": 2},
                numeric_summaries={"revenue": {"mean": 15.0}},
                likely_time_columns=[],
                likely_categorical_columns=[],
                sample_rows=[],
            )
        ],
        warnings=[],
    )


def test_inspector_returns_action(tmp_path: Path) -> None:
    action = ExplorationAction(
        kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
        title="Summarize revenue",
        description="Compute average revenue",
    )
    inspector = Inspector(FakeModel(action))

    result = inspector.next_action(make_brief(), make_profile(tmp_path), [], "")

    assert result == action


def test_reviewer_returns_decision() -> None:
    decision = ReviewDecision(approved=True, reason="Relevant")
    reviewer = Reviewer(FakeModel(decision))
    action = ExplorationAction(
        kind=ExplorationActionKind.INSPECT_SCHEMA,
        title="Inspect",
        description="Inspect schema",
    )

    result = reviewer.review_action(make_brief(), action)

    assert result.approved is True


def test_coder_returns_code_draft() -> None:
    draft = CodeDraft(
        code="print('ok')",
        purpose="Check data",
        expected_observation="ok",
    )
    coder = Coder(FakeModel(draft))
    action = ExplorationAction(
        kind=ExplorationActionKind.INSPECT_SCHEMA,
        title="Inspect",
        description="Inspect schema",
    )

    assert coder.write_code(make_brief(), action) == draft


def test_debugger_returns_debug_decision() -> None:
    decision = DebugDecision(retry=True, code="print('fixed')", reason="Name fixed")
    debugger = Debugger(FakeModel(decision))

    result = debugger.debug(make_brief(), "print(x)", "NameError")

    assert result.retry is True
```

- [ ] **Step 2: Run actor tests to verify failure**

Run:

```bash
uv run pytest tests/exploration/test_actors.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.exploration'`.

- [ ] **Step 3: Implement actors**

Create `src/statigent/exploration/actors.py`:

```python
from langchain.chat_models import BaseChatModel

from statigent.schemas import (
    CodeDraft,
    DatasetProfile,
    DebugDecision,
    ExplorationAction,
    ExplorationStep,
    FinalDraft,
    ReviewDecision,
    TaskBrief,
)


class Inspector:
    def __init__(self, model: BaseChatModel) -> None:
        self.model = model

    def next_action(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
        reviewer_feedback: str,
    ) -> ExplorationAction:
        structured = self.model.with_structured_output(ExplorationAction)
        return structured.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the Inspector. Choose the next useful data "
                        "exploration action. Prefer predefined DEA actions."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Profile:\n{profile.compact_summary()}\n\n"
                        f"Completed steps: {len(steps)}\n"
                        f"Reviewer feedback:\n{reviewer_feedback}"
                    ),
                },
            ]
        )

    def final_draft(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
    ) -> FinalDraft:
        structured = self.model.with_structured_output(FinalDraft)
        return structured.invoke(
            [
                {
                    "role": "system",
                    "content": "You are the Inspector. Draft the final answer or report.",
                },
                {
                    "role": "user",
                    "content": (
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Profile:\n{profile.compact_summary()}\n\n"
                        f"Exploration steps:\n{[s.model_dump() for s in steps]}"
                    ),
                },
            ]
        )


class Reviewer:
    def __init__(self, model: BaseChatModel) -> None:
        self.model = model

    def review_action(
        self,
        brief: TaskBrief,
        action: ExplorationAction,
    ) -> ReviewDecision:
        structured = self.model.with_structured_output(ReviewDecision)
        return structured.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the Reviewer. Approve only relevant, necessary, "
                        "safe exploration actions. Apply strict scrutiny to "
                        "custom_analysis."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Action:\n{action.model_dump_json()}"
                    ),
                },
            ]
        )

    def review_final(self, brief: TaskBrief, draft: FinalDraft) -> ReviewDecision:
        structured = self.model.with_structured_output(ReviewDecision)
        return structured.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the final Reviewer. Approve only if the draft "
                        "answers the task, cites evidence, and follows output constraints."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Draft:\n{draft.model_dump_json()}"
                    ),
                },
            ]
        )


class Coder:
    def __init__(self, model: BaseChatModel) -> None:
        self.model = model

    def write_code(self, brief: TaskBrief, action: ExplorationAction) -> CodeDraft:
        structured = self.model.with_structured_output(CodeDraft)
        return structured.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the Coder. Write one incremental Python notebook "
                        "cell for the approved data analysis action."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Action:\n{action.model_dump_json()}"
                    ),
                },
            ]
        )


class Debugger:
    def __init__(self, model: BaseChatModel) -> None:
        self.model = model

    def debug(self, brief: TaskBrief, code: str, error: str) -> DebugDecision:
        structured = self.model.with_structured_output(DebugDecision)
        return structured.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the Debugger. Return corrected code if retrying "
                        "is useful; otherwise explain why to abandon this action."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Failed code:\n{code}\n\nError:\n{error}"
                    ),
                },
            ]
        )
```

- [ ] **Step 4: Export actors**

Create `src/statigent/exploration/__init__.py`:

```python
from statigent.exploration.actors import Coder, Debugger, Inspector, Reviewer

__all__ = ["Coder", "Debugger", "Inspector", "Reviewer"]
```

- [ ] **Step 5: Run actor tests**

Run:

```bash
uv run pytest tests/exploration/test_actors.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit if commits are allowed**

```bash
git add src/statigent/exploration tests/exploration/test_actors.py
git commit -m "feat: add exploration actors"
```

### Task 8: Implement Exploration Orchestrator

**Files:**
- Create: `src/statigent/exploration/orchestrator.py`
- Modify: `src/statigent/exploration/__init__.py`
- Test: `tests/exploration/test_orchestrator.py`

- [ ] **Step 1: Write orchestrator tests**

Create `tests/exploration/test_orchestrator.py`:

```python
from pathlib import Path

from statigent.exploration import ExplorationOrchestrator
from statigent.notebook import FakeNotebookKernel, NotebookContext
from statigent.schemas import (
    CodeDraft,
    Complexity,
    DatasetProfile,
    DebugDecision,
    ExplorationAction,
    ExplorationActionKind,
    FinalDraft,
    InputFileInfo,
    OutputType,
    ReviewDecision,
    TableProfile,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


class FakeInspector:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *_args: object) -> ExplorationAction:
        self.calls += 1
        return ExplorationAction(
            kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
            title="Summarize revenue",
            description="Compute revenue mean",
        )

    def final_draft(self, *_args: object) -> FinalDraft:
        return FinalDraft(content="Average revenue is 15.", evidence=["mean=15"])


class FakeReviewer:
    def __init__(self, final_approved: bool = True) -> None:
        self.final_approved = final_approved

    def review_action(self, *_args: object) -> ReviewDecision:
        return ReviewDecision(approved=True, reason="Relevant")

    def review_final(self, *_args: object) -> ReviewDecision:
        return ReviewDecision(approved=self.final_approved, reason="Good enough")


class FakeCoder:
    def write_code(self, *_args: object) -> CodeDraft:
        return CodeDraft(
            code="print('mean=15')",
            purpose="Compute mean",
            expected_observation="mean=15",
        )


class FakeDebugger:
    def debug(self, *_args: object) -> DebugDecision:
        return DebugDecision(retry=True, code="print('fixed')", reason="Fixed")


def make_brief() -> TaskBrief:
    return TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        objective="Find average revenue",
        output_type=OutputType.ANSWER,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.SIMPLE,
        budgets=budget_for_complexity(Complexity.SIMPLE),
    )


def make_profile(tmp_path: Path) -> DatasetProfile:
    path = tmp_path / "sales.csv"
    return DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=path,
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=10,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=path,
                relative_path="sales.csv",
                rows=2,
                columns=1,
                column_names=["revenue"],
                dtypes={"revenue": "int64"},
                missing_rates={"revenue": 0.0},
                unique_counts={"revenue": 2},
                numeric_summaries={"revenue": {"mean": 15.0}},
                likely_time_columns=[],
                likely_categorical_columns=[],
                sample_rows=[],
            )
        ],
        warnings=[],
    )


def test_orchestrator_runs_action_and_returns_report(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="mean=15\n")
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    orchestrator = ExplorationOrchestrator(
        inspector=FakeInspector(),
        reviewer=FakeReviewer(),
        coder=FakeCoder(),
        debugger=FakeDebugger(),
        kernel=kernel,
    )

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "success"
    assert report.final_draft.content == "Average revenue is 15."
    assert len(report.steps) == 1


def test_orchestrator_debugs_failed_cell(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stderr="NameError", exit_code=1)
    kernel.queue_result(stdout="fixed\n", exit_code=0)
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    orchestrator = ExplorationOrchestrator(
        inspector=FakeInspector(),
        reviewer=FakeReviewer(),
        coder=FakeCoder(),
        debugger=FakeDebugger(),
        kernel=kernel,
    )

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.steps[0].debug_attempts == 1
    assert report.steps[0].result is not None
    assert report.steps[0].result.ok


def test_orchestrator_returns_partial_when_final_review_fails(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="mean=15\n")
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    orchestrator = ExplorationOrchestrator(
        inspector=FakeInspector(),
        reviewer=FakeReviewer(final_approved=False),
        coder=FakeCoder(),
        debugger=FakeDebugger(),
        kernel=kernel,
    )

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "partial"
    assert report.warnings
```

- [ ] **Step 2: Run orchestrator tests to verify failure**

Run:

```bash
uv run pytest tests/exploration/test_orchestrator.py -v
```

Expected: FAIL with `ImportError: cannot import name 'ExplorationOrchestrator'`.

- [ ] **Step 3: Implement orchestrator**

Create `src/statigent/exploration/orchestrator.py`:

```python
from statigent.notebook.base import NotebookKernel
from statigent.schemas import (
    DatasetProfile,
    ExplorationReport,
    ExplorationStep,
    FinalDraft,
    TaskBrief,
)


class ExplorationOrchestrator:
    def __init__(
        self,
        *,
        inspector: object,
        reviewer: object,
        coder: object,
        debugger: object,
        kernel: NotebookKernel,
    ) -> None:
        self.inspector = inspector
        self.reviewer = reviewer
        self.coder = coder
        self.debugger = debugger
        self.kernel = kernel

    def run(self, brief: TaskBrief, profile: DatasetProfile) -> ExplorationReport:
        steps: list[ExplorationStep] = []
        warnings: list[str] = []
        reviewer_feedback = ""

        for _round in range(brief.budgets.max_rounds):
            if len([s for s in steps if s.code is not None]) >= brief.budgets.max_code_cells:
                warnings.append("Code cell budget exhausted")
                break

            action = self.inspector.next_action(
                brief,
                profile,
                steps,
                reviewer_feedback,
            )
            review = self.reviewer.review_action(brief, action)
            if not review.approved:
                reviewer_feedback = review.reason
                warnings.append(f"Reviewer rejected action: {review.reason}")
                continue

            approved_action = review.revised_action or action
            code = self.coder.write_code(brief, approved_action)
            result = self.kernel.execute_cell(code.code, code.purpose)
            debug_attempts = 0
            while not result.ok and debug_attempts < brief.budgets.max_debug_attempts:
                debug_attempts += 1
                decision = self.debugger.debug(
                    brief,
                    result.code,
                    result.error_summary or result.stderr,
                )
                if not decision.retry:
                    warnings.append(f"Debugger abandoned action: {decision.reason}")
                    break
                result = self.kernel.execute_cell(decision.code, code.purpose)

            if not result.ok:
                warnings.append(f"Exploration action failed: {approved_action.title}")

            steps.append(
                ExplorationStep(
                    action=approved_action,
                    review=review,
                    code=code,
                    result=result,
                    debug_attempts=debug_attempts,
                )
            )
            break

        if steps:
            draft = self.inspector.final_draft(brief, profile, steps)
        else:
            draft = FinalDraft(
                content="No exploration steps were completed.",
                warnings=["No approved exploration action completed."],
            )
        final_review = self.reviewer.review_final(brief, draft)
        status = "success" if final_review.approved else "partial"
        if not final_review.approved:
            warnings.append(f"Final review did not approve the draft: {final_review.reason}")

        return ExplorationReport(
            status=status,
            final_draft=draft,
            steps=steps,
            artifacts=self.kernel.list_artifacts(),
            warnings=[*warnings, *draft.warnings],
        )
```

- [ ] **Step 4: Export orchestrator**

Modify `src/statigent/exploration/__init__.py`:

```python
from statigent.exploration.actors import Coder, Debugger, Inspector, Reviewer
from statigent.exploration.orchestrator import ExplorationOrchestrator

__all__ = [
    "Coder",
    "Debugger",
    "ExplorationOrchestrator",
    "Inspector",
    "Reviewer",
]
```

- [ ] **Step 5: Run orchestrator tests**

Run:

```bash
uv run pytest tests/exploration/test_orchestrator.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit if commits are allowed**

```bash
git add src/statigent/exploration tests/exploration/test_orchestrator.py
git commit -m "feat: add exploration orchestrator"
```

### Task 9: Implement Output Renderer

**Files:**
- Create: `src/statigent/output/__init__.py`
- Create: `src/statigent/output/renderer.py`
- Test: `tests/output/test_renderer.py`

- [ ] **Step 1: Write renderer tests**

Create `tests/output/test_renderer.py`:

```python
from statigent.output import OutputRenderer
from statigent.schemas import (
    Complexity,
    ExplorationReport,
    FinalDraft,
    OutputStatus,
    OutputType,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


def make_brief(task_type: TaskType, output_type: OutputType) -> TaskBrief:
    return TaskBrief(
        task_type=task_type,
        objective="Analyze sales",
        output_type=output_type,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.SIMPLE,
        budgets=budget_for_complexity(Complexity.SIMPLE),
    )


def make_report() -> ExplorationReport:
    return ExplorationReport(
        status="success",
        final_draft=FinalDraft(content="Sales increased.", evidence=["trend up"]),
        steps=[],
        artifacts=[],
        warnings=[],
    )


def test_renderer_returns_answer_bundle() -> None:
    bundle = OutputRenderer().render(make_brief(TaskType.DATA_ANALYSIS, OutputType.ANSWER), make_report())

    assert bundle.status is OutputStatus.SUCCESS
    assert bundle.output_type is OutputType.ANSWER
    assert bundle.content == "Sales increased."


def test_renderer_returns_unsupported_for_deep_analysis() -> None:
    bundle = OutputRenderer().render_unsupported(
        make_brief(TaskType.DEEP_ANALYSIS, OutputType.REPORT)
    )

    assert bundle.status is OutputStatus.UNSUPPORTED
    assert "deep_analysis" in bundle.content


def test_renderer_returns_partial_for_partial_report() -> None:
    report = make_report()
    report.status = "partial"
    report.warnings.append("Budget exhausted")

    bundle = OutputRenderer().render(make_brief(TaskType.DATA_ANALYSIS, OutputType.REPORT), report)

    assert bundle.status is OutputStatus.PARTIAL
    assert bundle.warnings == ["Budget exhausted"]
```

- [ ] **Step 2: Run renderer tests to verify failure**

Run:

```bash
uv run pytest tests/output/test_renderer.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.output'`.

- [ ] **Step 3: Implement renderer**

Create `src/statigent/output/renderer.py`:

```python
from statigent.schemas import (
    ExplorationReport,
    OutputBundle,
    OutputStatus,
    OutputType,
    TaskBrief,
)


class OutputRenderer:
    def render(
        self,
        brief: TaskBrief,
        report: ExplorationReport,
    ) -> OutputBundle:
        status = (
            OutputStatus.SUCCESS
            if report.status == "success"
            else OutputStatus.PARTIAL
        )
        content = report.final_draft.content
        if brief.output_type is OutputType.FILE and report.artifacts:
            artifact_lines = "\n".join(f"- {a.name}: {a.path}" for a in report.artifacts)
            content = f"{content}\n\nGenerated files:\n{artifact_lines}"
        return OutputBundle(
            status=status,
            output_type=brief.output_type,
            content=content,
            artifacts=report.artifacts,
            warnings=report.warnings,
            trace_summary=f"{len(report.steps)} exploration step(s)",
        )

    def render_unsupported(self, brief: TaskBrief) -> OutputBundle:
        return OutputBundle(
            status=OutputStatus.UNSUPPORTED,
            output_type=brief.output_type,
            content=(
                f"Task type '{brief.task_type.value}' is recognized but is not "
                "implemented in this architecture phase."
            ),
            artifacts=[],
            warnings=[
                f"{brief.task_type.value} routing is present; execution is not implemented."
            ],
            trace_summary="Unsupported task route",
        )
```

- [ ] **Step 4: Export renderer**

Create `src/statigent/output/__init__.py`:

```python
from statigent.output.renderer import OutputRenderer

__all__ = ["OutputRenderer"]
```

- [ ] **Step 5: Run renderer tests**

Run:

```bash
uv run pytest tests/output/test_renderer.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit if commits are allowed**

```bash
git add src/statigent/output tests/output/test_renderer.py
git commit -m "feat: add output renderer"
```

### Task 10: Add Benchmark-Compatible Agent Wrapper

**Files:**
- Create: `src/statigent/agents/__init__.py`
- Create: `src/statigent/agents/data_science.py`
- Test: `tests/agents/test_data_science_agent.py`

- [ ] **Step 1: Write agent wrapper tests**

Create `tests/agents/test_data_science_agent.py`:

```python
from pathlib import Path

from statigent.agents import StatigentDataScienceAgent
from statigent.benchmarks.base import DataScienceAgent
from statigent.schemas import (
    Budget,
    Complexity,
    DatasetProfile,
    InputFileInfo,
    OutputType,
    TableProfile,
    TaskBrief,
    TaskType,
)


class FakeProfiler:
    def __init__(self, profile: DatasetProfile) -> None:
        self.profile = profile

    def profile_paths(self, _paths: list[Path] | None) -> DatasetProfile:
        return self.profile


class FakePlanner:
    def __init__(self, brief: TaskBrief) -> None:
        self.brief = brief

    def create_brief(
        self,
        *,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief:
        return self.brief


class FakeOrchestrator:
    def run(self, _brief: TaskBrief, _profile: DatasetProfile):
        from statigent.schemas import ExplorationReport, FinalDraft

        return ExplorationReport(
            status="success",
            final_draft=FinalDraft(content="Answer is 42", evidence=["computed"]),
            steps=[],
            artifacts=[],
            warnings=[],
        )


def make_profile(tmp_path: Path) -> DatasetProfile:
    path = tmp_path / "sales.csv"
    return DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=path,
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=10,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=path,
                relative_path="sales.csv",
                rows=1,
                columns=1,
                column_names=["x"],
                dtypes={"x": "int64"},
                missing_rates={"x": 0.0},
                unique_counts={"x": 1},
                numeric_summaries={"x": {"mean": 1.0}},
                likely_time_columns=[],
                likely_categorical_columns=[],
                sample_rows=[],
            )
        ],
        warnings=[],
    )


def make_brief(task_type: TaskType) -> TaskBrief:
    return TaskBrief(
        task_type=task_type,
        objective="Answer",
        output_type=OutputType.ANSWER,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.SIMPLE,
        budgets=Budget(
            max_rounds=1,
            max_code_cells=1,
            max_debug_attempts=0,
            timeout_seconds=60,
        ),
    )


def test_agent_satisfies_protocol(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    agent: DataScienceAgent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(make_brief(TaskType.DATA_ANALYSIS)),
        orchestrator_factory=lambda _brief, _profile, _work_dir: FakeOrchestrator(),
    )

    response, trace = agent.run_analysis_for_eval("question", files=[])

    assert response == "Answer is 42"
    assert trace[-1]["role"] == "assistant"


def test_agent_returns_unsupported_for_deep_analysis(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    agent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(make_brief(TaskType.DEEP_ANALYSIS)),
        orchestrator_factory=lambda _brief, _profile, _work_dir: FakeOrchestrator(),
    )

    response, _trace = agent.run_analysis_for_eval("deep report", files=[])

    assert "deep_analysis" in response
    assert "not implemented" in response


def test_modeling_eval_returns_unsupported_submission_path(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    agent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(make_brief(TaskType.DATA_MODELING)),
        orchestrator_factory=lambda _brief, _profile, _work_dir: FakeOrchestrator(),
    )
    train = tmp_path / "train.csv"
    test = tmp_path / "test.csv"
    sample = tmp_path / "sample_submission.csv"
    for path in (train, test, sample):
        path.write_text("x\n1\n")

    submission_path, trace = agent.run_modeling_for_eval(
        "predict",
        train_path=train,
        test_path=test,
        sample_submission_path=sample,
        work_dir=tmp_path / "work",
    )

    assert submission_path.name == "submission.csv"
    assert not submission_path.exists()
    assert any("not implemented" in msg["content"] for msg in trace)
```

- [ ] **Step 2: Run agent tests to verify failure**

Run:

```bash
uv run pytest tests/agents/test_data_science_agent.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.agents'`.

- [ ] **Step 3: Implement agent wrapper**

Create `src/statigent/agents/data_science.py`:

```python
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from statigent.benchmarks.base import AgentTrace
from statigent.exploration import Coder, Debugger, ExplorationOrchestrator, Inspector, Reviewer
from statigent.input import InputProfiler, TaskBriefPlanner
from statigent.models import get_model
from statigent.notebook import DockerNotebookKernel, NotebookContext
from statigent.output import OutputRenderer
from statigent.schemas import DatasetProfile, OutputBundle, TaskBrief, TaskType


class StatigentDataScienceAgent:
    name = "statigent-data-science"

    def __init__(
        self,
        model_name: str = "deepseek-v4-flash",
        *,
        profiler: Any | None = None,
        planner: Any | None = None,
        orchestrator_factory: Callable[[TaskBrief, DatasetProfile, Path], Any] | None = None,
        renderer: OutputRenderer | None = None,
    ) -> None:
        self.model_name = model_name
        self.profiler = profiler
        self.planner = planner
        self.orchestrator_factory = orchestrator_factory
        self.renderer = renderer or OutputRenderer()

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        work_dir = Path(tempfile.mkdtemp(prefix="statigent-agent-"))
        profile = self._profiler(work_dir).profile_paths(files)
        brief = self._planner().create_brief(
            prompt=prompt,
            task_instructions=task_instructions,
            profile=profile,
        )
        trace: AgentTrace = [
            {"role": "system", "content": profile.compact_summary(), "name": "input"},
            {"role": "assistant", "content": brief.model_dump_json(), "name": "task_brief"},
        ]
        if brief.task_type in {TaskType.DATA_MODELING, TaskType.DEEP_ANALYSIS, TaskType.UNKNOWN}:
            bundle = self.renderer.render_unsupported(brief)
            trace.append({"role": "assistant", "content": bundle.content, "name": "output"})
            return bundle.content, trace

        orchestrator = self._orchestrator(brief, profile, work_dir)
        report = orchestrator.run(brief, profile)
        bundle = self.renderer.render(brief, report)
        trace.append({"role": "assistant", "content": bundle.model_dump_json(), "name": "output"})
        return bundle.content, trace

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
        work_dir: Path | None = None,
    ) -> tuple[Path, AgentTrace]:
        target_dir = work_dir or Path(tempfile.mkdtemp(prefix="statigent-modeling-"))
        response, trace = self.run_analysis_for_eval(
            prompt,
            files=[train_path, test_path, sample_submission_path],
            task_instructions=task_instructions,
        )
        trace.append(
            {
                "role": "assistant",
                "content": f"Modeling submission generation is not implemented: {response}",
                "name": "modeling_placeholder",
            }
        )
        return target_dir / "submission.csv", trace

    def _profiler(self, work_dir: Path) -> Any:
        if self.profiler is not None:
            return self.profiler
        return InputProfiler(work_dir=work_dir)

    def _planner(self) -> Any:
        if self.planner is not None:
            return self.planner
        return TaskBriefPlanner(model=get_model(self.model_name))

    def _orchestrator(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        work_dir: Path,
    ) -> Any:
        if self.orchestrator_factory is not None:
            return self.orchestrator_factory(brief, profile, work_dir)
        model = get_model(self.model_name)
        kernel = DockerNotebookKernel()
        kernel.start(
            NotebookContext(
                input_paths=[file.path for file in profile.files],
                work_dir=work_dir,
                timeout_seconds=brief.budgets.timeout_seconds,
            )
        )
        return ExplorationOrchestrator(
            inspector=Inspector(model),
            reviewer=Reviewer(model),
            coder=Coder(model),
            debugger=Debugger(model),
            kernel=kernel,
        )
```

- [ ] **Step 4: Export agent**

Create `src/statigent/agents/__init__.py`:

```python
from statigent.agents.data_science import StatigentDataScienceAgent

__all__ = ["StatigentDataScienceAgent"]
```

- [ ] **Step 5: Run agent tests**

Run:

```bash
uv run pytest tests/agents/test_data_science_agent.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit if commits are allowed**

```bash
git add src/statigent/agents tests/agents/test_data_science_agent.py
git commit -m "feat: add statigent data science agent"
```

### Task 11: Add Protocol Smoke Tests and Public Exports

**Files:**
- Modify: `src/statigent/__init__.py`
- Test: `tests/agents/test_protocol_smoke.py`

- [ ] **Step 1: Write smoke tests**

Create `tests/agents/test_protocol_smoke.py`:

```python
from pathlib import Path

from statigent import StatigentDataScienceAgent
from statigent.benchmarks.base import DataScienceAgent


def test_public_agent_export_exists() -> None:
    agent = StatigentDataScienceAgent(model_name="fake")

    assert agent.name == "statigent-data-science"


def test_agent_has_data_science_protocol_methods() -> None:
    agent: DataScienceAgent = StatigentDataScienceAgent(model_name="fake")

    assert hasattr(agent, "run_analysis_for_eval")
    assert hasattr(agent, "run_modeling_for_eval")
```

- [ ] **Step 2: Run smoke tests to verify failure**

Run:

```bash
uv run pytest tests/agents/test_protocol_smoke.py -v
```

Expected: FAIL with `ImportError: cannot import name 'StatigentDataScienceAgent'`.

- [ ] **Step 3: Export new agent from package root**

Modify `src/statigent/__init__.py` to include:

```python
from statigent.agents import StatigentDataScienceAgent
from statigent.models import get_model, load_registry

__all__ = ["StatigentDataScienceAgent", "get_model", "load_registry"]
```

If `src/statigent/__init__.py` already has exports, preserve them and add `StatigentDataScienceAgent`.

- [ ] **Step 4: Run smoke tests**

Run:

```bash
uv run pytest tests/agents/test_protocol_smoke.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit if commits are allowed**

```bash
git add src/statigent/__init__.py tests/agents/test_protocol_smoke.py
git commit -m "feat: export data science agent"
```

### Task 12: Run Quality Gates and Fix Strict Typing

**Files:**
- Modify files touched by earlier tasks as required by ruff and mypy.

- [ ] **Step 1: Run focused tests**

Run:

```bash
uv run pytest tests/test_schemas.py tests/input tests/notebook tests/exploration tests/output tests/agents -v
```

Expected: PASS.

- [ ] **Step 2: Run ruff check**

Run:

```bash
uv run ruff check src tests
```

Expected: PASS. If it fails, apply the reported import ordering, style, or simplification fixes exactly.

- [ ] **Step 3: Run ruff format**

Run:

```bash
uv run ruff format src tests
```

Expected: Files are either unchanged or formatted.

- [ ] **Step 4: Run mypy**

Run:

```bash
uv run mypy src
```

Expected: PASS. If mypy rejects fake classes typed as `BaseChatModel`, introduce small `Protocol` types in the implementation files instead of using `Any` broadly:

```python
from typing import Protocol, TypeVar

T = TypeVar("T")


class StructuredRunnable(Protocol[T]):
    def invoke(self, messages: list[dict[str, str]]) -> T: ...


class StructuredModel(Protocol):
    def with_structured_output(self, schema: type[T]) -> StructuredRunnable[T]: ...
```

Then update actor and planner constructors to accept `StructuredModel`.

- [ ] **Step 5: Run full pytest suite**

Run:

```bash
uv run pytest
```

Expected: PASS.

- [ ] **Step 6: Commit final fixes if commits are allowed**

```bash
git add src tests pyproject.toml uv.lock
git commit -m "test: verify data science agent architecture"
```

## Self-Review

- Spec coverage: schemas, input profiling, task brief generation, `deep_analysis`, unsupported `data_modeling`, notebook abstraction, real LLM actor wrappers, explicit orchestrator, output routing, trace-compatible agent wrapper, and testing are all mapped to tasks.
- Scope check: the plan avoids implementing full modeling or deep commercial analysis. It only routes them and returns explicit unsupported output.
- Type consistency: `TaskBrief`, `DatasetProfile`, `ExplorationAction`, `NotebookCellResult`, `ExplorationReport`, and `OutputBundle` names match across tasks.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain. Commit steps are conditional because repository instructions require explicit user permission before creating commits.
