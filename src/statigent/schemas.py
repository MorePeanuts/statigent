"""Shared Pydantic boundary schemas for the data science agent architecture.

These models flow across all layers: input profiling &rarr; task planning
&rarr; notebook execution &rarr; exploration orchestration &rarr; output rendering.
Docstrings, type annotations, and field constraints keep those hand-offs
explicit while remaining compatible with LangChain structured outputs.
"""

from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class TaskType(StrEnum):
    """Classification of a data science task by scope and expected output."""

    DATA_ANALYSIS = "data_analysis"
    DATA_MODELING = "data_modeling"
    DEEP_ANALYSIS = "deep_analysis"
    UNKNOWN = "unknown"


class OutputType(StrEnum):
    """Shape of the final deliverable requested by the user."""

    ANSWER = "answer"
    REPORT = "report"
    FILE = "file"


class Complexity(StrEnum):
    """Estimated difficulty tier, used to select resource budgets."""

    SIMPLE = "simple"
    MODERATE = "moderate"
    COMPLEX = "complex"


class OutputStatus(StrEnum):
    """Terminal status of an output bundle."""

    SUCCESS = "success"
    PARTIAL = "partial"
    UNSUPPORTED = "unsupported"
    ERROR = "error"


class ExplorationActionKind(StrEnum):
    """Predefined data exploration actions the Inspector can choose from.

    CUSTOM_ANALYSIS requires rationale, expected_evidence, and risk_notes;
    all other kinds are safe with just a title and description.
    """

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
    """Resource caps for an exploration run."""

    max_rounds: int = Field(ge=1, description="Maximum exploration rounds allowed")
    max_code_cells: int = Field(
        ge=1, description="Maximum code cells that can be executed"
    )
    max_debug_attempts: int = Field(
        ge=0, description="Maximum debug retries per failed cell"
    )
    timeout_seconds: int = Field(ge=1, description="Wall-clock timeout in seconds")


def budget_for_complexity(complexity: Complexity) -> Budget:
    """Return the system-owned resource budget for a complexity tier."""
    if complexity is Complexity.SIMPLE:
        return Budget(
            max_rounds=3,
            max_code_cells=6,
            max_debug_attempts=2,
            timeout_seconds=180,
        )
    if complexity is Complexity.MODERATE:
        return Budget(
            max_rounds=7,
            max_code_cells=14,
            max_debug_attempts=3,
            timeout_seconds=480,
        )
    return Budget(
        max_rounds=12,
        max_code_cells=28,
        max_debug_attempts=5,
        timeout_seconds=900,
    )


class InputFileInfo(BaseModel):
    """Metadata for a single file discovered during input scanning."""

    path: Path = Field(description="Absolute path to the file on disk")
    relative_path: str = Field(description="Path relative to the dataset root")
    suffix: str = Field(description="File extension including the dot (e.g. .csv)")
    size_bytes: int = Field(ge=0, description="File size in bytes")
    is_tabular: bool = Field(description="Whether the file contains tabular data")
    warnings: list[str] = Field(
        default_factory=list, description="Issues found during scanning"
    )


class TableProfile(BaseModel):
    """Statistical profile of a single tabular data source."""

    path: Path = Field(description="Absolute path to the table file")
    relative_path: str = Field(description="Path relative to the dataset root")
    rows: int = Field(ge=0, description="Number of rows in the table")
    columns: int = Field(ge=0, description="Number of columns in the table")
    column_names: list[str] = Field(description="Ordered list of column names")
    dtypes: dict[str, str] = Field(description="Mapping of column name to dtype string")
    missing_rates: dict[str, float] = Field(
        description="Fraction of nulls per column (0.0-1.0)"
    )
    unique_counts: dict[str, int] = Field(
        description="Number of distinct values per column"
    )
    numeric_summaries: dict[str, dict[str, float]] = Field(
        description="Per-column stats: mean, std, min, max, etc."
    )
    likely_time_columns: list[str] = Field(
        description="Columns that appear to contain temporal data"
    )
    likely_categorical_columns: list[str] = Field(
        description="Columns that appear to contain categorical data"
    )
    sample_rows: list[dict[str, object]] = Field(
        description="Representative rows for LLM context"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Issues found during profiling"
    )


class DatasetProfile(BaseModel):
    """Complete profile of all input files and tables discovered by the profiler.

    The compact_summary method produces the text representation fed into
    LLM prompts for task planning.
    """

    root: Path = Field(description="Root directory of the dataset")
    files: list[InputFileInfo] = Field(
        description="All files discovered during scanning"
    )
    tables: list[TableProfile] = Field(description="Profiles of tabular data sources")
    warnings: list[str] = Field(
        default_factory=list, description="Cross-file issues found during scanning"
    )

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
    """Structured task plan produced by the TaskBriefPlanner.

    This is the primary hand-off from the input layer to the exploration
    orchestrator. It captures what to do, how complex it is, and how many
    resources to allocate.
    """

    task_type: TaskType = Field(description="Category of task requested by the user")
    objective: str = Field(
        description="Natural-language description of what the user wants"
    )
    output_type: OutputType = Field(
        description="Shape of deliverable requested by the user"
    )
    requirements: list[str] = Field(
        default_factory=list, description="Explicit requirements from user instructions"
    )
    data_context: str = Field(description="Summary of the input dataset for context")
    complexity: Complexity = Field(
        description="Expected effort tier for completing the task"
    )
    budgets: Budget = Field(
        description="System-derived resource caps for the selected effort tier"
    )
    analysis_hints: list[str] = Field(
        default_factory=list, description="Suggested analysis directions"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Caveats from the planning stage"
    )


# BUG: See the `next_action` method of the Inspector; this method is not suitable
# for structured output.
class ExplorationAction(BaseModel):
    """A single exploration step proposed by the Inspector.

    CUSTOM_ANALYSIS actions must supply rationale, expected_evidence, and
    risk_notes — enforced by the model validator below.
    """

    kind: ExplorationActionKind = Field(
        description="Which predefined action to perform"
    )
    # BUG: Each predefined exploration action should correspond to a carefully designed
    # exploration prompt, similar to skills. The Inspector is responsible for outputting
    # its analysis process and conclusions, which are then parsed by the reviewer to
    # extract actions and integrate the prompts.
    title: str = Field(description="Short human-readable label for the action")
    description: str = Field(description="What this action will investigate or compute")
    rationale: str = Field(
        default="", description="Why this action is worth performing"
    )
    expected_evidence: str = Field(
        default="", description="What output would confirm the action was useful"
    )
    risk_notes: str = Field(
        default="", description="Potential pitfalls or side effects"
    )

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
    """Pointer to a generated file (chart, table, report) from exploration."""

    name: str = Field(description="Short identifier for the artifact")
    path: Path = Field(description="Filesystem path to the artifact")
    kind: str = Field(description="Artifact category (chart, table, report, etc.)")
    description: str = Field(
        default="", description="What the artifact contains or shows"
    )


class NotebookCellResult(BaseModel):
    """Result of executing a single notebook cell."""

    cell_id: str = Field(description="Unique identifier for the cell")
    code: str = Field(description="Python source code that was executed")
    purpose: str = Field(description="Why this cell was run")
    stdout: str = Field(default="", description="Captured standard output")
    stderr: str = Field(default="", description="Captured standard error")
    exit_code: int = Field(description="Process exit code (0 = success)")
    duration_ms: int = Field(ge=0, description="Execution time in milliseconds")
    artifacts: list[ArtifactRef] = Field(
        default_factory=list, description="Files generated by this cell"
    )
    error_summary: str = Field(
        default="", description="Human-readable error summary if failed"
    )

    @property
    def ok(self) -> bool:
        return self.exit_code == 0


class NotebookCell(BaseModel):
    """Durable notebook code cell with planning metadata and latest result."""

    cell_id: str = Field(description="Stable identifier for this notebook cell")
    code: str = Field(description="Python source code stored in the cell")
    purpose: str = Field(description="Why this cell exists")
    expected_observation: str = Field(
        description="What output or result this cell is expected to produce"
    )
    latest_result: NotebookCellResult | None = Field(
        default=None, description="Most recent execution result for this cell"
    )


class NotebookCodeContext(BaseModel):
    """Ordered notebook code cells available to exploration actors."""

    cells: list[NotebookCell] = Field(
        default_factory=list, description="Notebook cells in insertion order"
    )


class NotebookState(BaseModel):
    """Accumulated state of a notebook session — all executed cells and artifacts."""

    executed_cells: list[NotebookCellResult] = Field(
        default_factory=list, description="All cell execution results in order"
    )
    artifacts: list[ArtifactRef] = Field(
        default_factory=list, description="All artifacts accumulated across cells"
    )


class ReviewDecision(BaseModel):
    """Decision from the Reviewer actor — approve, reject, or revise an action."""

    approved: bool = Field(description="Whether the action or draft is accepted")
    reason: str = Field(description="Justification for the decision")
    revised_action: ExplorationAction | None = Field(
        default=None, description="Suggested alternative when rejecting an action"
    )


class CodeDraft(BaseModel):
    """Code written by the Coder actor for a single notebook cell."""

    code: str = Field(description="Python source code for the notebook cell")
    purpose: str = Field(description="What this code is intended to accomplish")
    expected_observation: str = Field(
        description="What output or result the code should produce"
    )


class DebugDecision(BaseModel):
    """Decision from the Debugger actor — retry with corrected code or abandon."""

    retry: bool = Field(description="Whether to retry with corrected code")
    code: str = Field(default="", description="Corrected source code if retrying")
    reason: str = Field(description="Diagnosis of the failure and fix rationale")


class FinalDraft(BaseModel):
    """Final answer or report drafted by the Inspector after exploration completes."""

    content: str = Field(description="The main answer or report text")
    evidence: list[str] = Field(
        default_factory=list, description="Supporting evidence from exploration steps"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Caveats about the draft"
    )


class ExplorationStep(BaseModel):
    """One complete step: action -> review -> code -> execute -> (debug)."""

    action: ExplorationAction = Field(description="The proposed exploration action")
    review: ReviewDecision = Field(description="Reviewer's decision on the action")
    code: CodeDraft | None = Field(
        default=None, description="Code written for this step"
    )
    result: NotebookCellResult | None = Field(
        default=None, description="Execution result of the code cell"
    )
    debug_attempts: int = Field(
        default=0, description="Number of debug retries for this step"
    )


class ExplorationReport(BaseModel):
    """Orchestrator output: steps, final draft, artifacts, and warnings."""

    status: Literal["success", "partial"] = Field(
        description="Whether exploration completed fully or partially"
    )
    final_draft: FinalDraft = Field(
        description="The Inspector's final answer or report"
    )
    steps: list[ExplorationStep] = Field(description="All exploration steps taken")
    artifacts: list[ArtifactRef] = Field(description="All generated artifacts")
    warnings: list[str] = Field(
        default_factory=list, description="Issues encountered during exploration"
    )


class OutputBundle(BaseModel):
    """Rendered output bound for the user or benchmark evaluator."""

    status: OutputStatus = Field(description="Terminal status of the output")
    output_type: OutputType = Field(description="Shape of the delivered content")
    content: str = Field(description="The rendered text or report")
    artifacts: list[ArtifactRef] = Field(
        default_factory=list, description="Accompanying generated files"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Caveats about the output"
    )
    trace_summary: str = Field(
        default="", description="Condensed agent trace for debugging"
    )


class TraceEvent(BaseModel):
    """Single event in an agent trace for benchmarking and observability."""

    role: str = Field(description="Message role for benchmark trace compatibility")
    content: str = Field(description="Event payload")
    name: str = Field(default="", description="Tool, phase, or action identifier")
    agent: str = Field(description="Agent or layer that produced the event")
    session: int = Field(
        default=1, ge=1, description="Independent session number for this agent"
    )
    metadata: dict[str, object] = Field(
        default_factory=dict, description="Additional event metadata"
    )


__all__ = [
    "ArtifactRef",
    "Budget",
    "CodeDraft",
    "Complexity",
    "DatasetProfile",
    "DebugDecision",
    "ExplorationAction",
    "ExplorationActionKind",
    "ExplorationReport",
    "ExplorationStep",
    "FinalDraft",
    "InputFileInfo",
    "NotebookCell",
    "NotebookCellResult",
    "NotebookCodeContext",
    "NotebookState",
    "OutputBundle",
    "OutputStatus",
    "OutputType",
    "ReviewDecision",
    "TableProfile",
    "TaskBrief",
    "TaskType",
    "TraceEvent",
    "budget_for_complexity",
]
