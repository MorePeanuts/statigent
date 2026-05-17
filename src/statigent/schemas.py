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
    "NotebookCellResult",
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
