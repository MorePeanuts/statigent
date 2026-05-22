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


class DatasetKind(StrEnum):
    """High-level shape of discovered input data."""

    EMPTY = "empty"
    SINGLE_TABLE = "single_table"
    MULTI_TABLE = "multi_table"
    MODELING_SPLIT_TABLES = "modeling_split_tables"
    SPREADSHEET_WORKBOOK = "spreadsheet_workbook"
    IMAGE_COLLECTION = "image_collection"
    MIXED = "mixed"


class TableRole(StrEnum):
    """Role of a logical table inside a dataset."""

    TABLE = "table"
    TRAIN = "train"
    VALIDATION = "validation"
    TEST = "test"
    SAMPLE_SUBMISSION = "sample_submission"


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
    source_file: Path | None = Field(
        default=None, description="Physical source file for this logical table"
    )
    source_label: str = Field(
        default="", description="Human-readable logical table identifier"
    )
    role: TableRole = Field(
        default=TableRole.TABLE, description="Semantic role of this table"
    )
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


class ImageCollectionProfile(BaseModel):
    """Profile of an image dataset discovered from files and directories."""

    root: Path = Field(description="Root path of the image collection")
    relative_root: str = Field(description="Root path relative to the dataset input")
    total_images: int = Field(ge=0, description="Number of image files discovered")
    format_counts: dict[str, int] = Field(description="Image counts by file suffix")
    resolution_counts: dict[str, int] = Field(
        description="Image counts by WIDTHxHEIGHT resolution"
    )
    directory_counts: dict[str, int] = Field(
        description="Image counts by containing directory"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Issues found during image profiling"
    )


class SpreadsheetSheetProfile(BaseModel):
    """Grid profile of a non-tabular spreadsheet worksheet."""

    name: str = Field(description="Worksheet name")
    rows: int = Field(ge=0, description="Worksheet used-range row count")
    columns: int = Field(ge=0, description="Worksheet used-range column count")
    non_empty_cells: int = Field(ge=0, description="Number of non-empty cells")
    formula_cells: int = Field(ge=0, description="Number of formula cells")
    preview_rows: list[str] = Field(
        description="Sparse top-left grid preview with row numbers"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Issues found during sheet profiling"
    )


class SpreadsheetWorkbookProfile(BaseModel):
    """Grid profile of a non-tabular spreadsheet workbook."""

    path: Path = Field(description="Absolute path to the workbook")
    relative_path: str = Field(description="Path relative to the dataset root")
    sheets: list[SpreadsheetSheetProfile] = Field(
        description="Profiles of workbook sheets"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Issues found during workbook profiling"
    )


class DatasetProfile(BaseModel):
    """Complete profile of all input files and tables discovered by the profiler.

    The compact_summary method produces the text representation fed into
    LLM prompts for task planning.
    """

    root: Path = Field(description="Root directory of the dataset")
    kind: DatasetKind = Field(
        default=DatasetKind.MIXED, description="High-level shape of the dataset"
    )
    files: list[InputFileInfo] = Field(
        description="All files discovered during scanning"
    )
    tables: list[TableProfile] = Field(description="Profiles of tabular data sources")
    image_collections: list[ImageCollectionProfile] = Field(
        default_factory=list, description="Profiles of discovered image collections"
    )
    spreadsheet_workbooks: list[SpreadsheetWorkbookProfile] = Field(
        default_factory=list,
        description="Profiles of non-tabular spreadsheet workbooks",
    )
    warnings: list[str] = Field(
        default_factory=list, description="Cross-file issues found during scanning"
    )

    def compact_summary(self) -> str:
        if self.kind is DatasetKind.SINGLE_TABLE:
            return self._single_table_summary()
        if self.kind is DatasetKind.MULTI_TABLE:
            return self._multi_table_summary()
        if self.kind is DatasetKind.MODELING_SPLIT_TABLES:
            return self._modeling_split_summary()
        if self.kind is DatasetKind.SPREADSHEET_WORKBOOK:
            return self._spreadsheet_workbook_summary()
        if self.kind is DatasetKind.IMAGE_COLLECTION:
            return self._image_collection_summary()
        if self.kind is DatasetKind.EMPTY:
            return self._append_warning_text("No input files were provided.")
        return self._fallback_summary()

    def _single_table_summary(self) -> str:
        if not self.tables:
            return self._append_warning_text(
                "Single table dataset\n- No table profiled."
            )
        table = self.tables[0]
        lines = [
            "Single table dataset",
            f"- Table: {table.source_label or table.relative_path}",
            f"- Shape: {table.rows} rows x {table.columns} columns",
            "- Columns:",
            *[
                f"  - {name}: {table.dtypes.get(name, 'unknown')}"
                for name in table.column_names
            ],
            "- First 5 rows:",
        ]
        for row in table.sample_rows[:5]:
            values = ", ".join(f"{key}={value}" for key, value in row.items())
            lines.append(f"  - {values}")
        return self._append_warning_text("\n".join(lines))

    def _multi_table_summary(self) -> str:
        lines = ["Multi-table dataset"]
        for table in self.tables:
            lines.append(
                f"- {table.source_label or table.relative_path}: "
                f"{table.rows} rows x {table.columns} columns"
            )
            lines.append("  Columns:")
            for name in table.column_names:
                lines.append(f"  - {name}: {table.dtypes.get(name, 'unknown')}")
        if not self.tables:
            lines.append("- No tabular files were profiled.")
        return self._append_warning_text("\n".join(lines))

    def _modeling_split_summary(self) -> str:
        lines = ["Modeling split tabular dataset"]
        for table in self.tables:
            lines.append(
                f"- {table.source_label or table.relative_path} [{table.role.value}]: "
                f"{table.rows} rows x {table.columns} columns"
            )
        if self.tables:
            column_sets = [set(table.column_names) for table in self.tables]
            common_columns = sorted(set.intersection(*column_sets))
            all_columns = sorted(set.union(*column_sets))
            lines.append(f"Common columns: {', '.join(common_columns) or 'none'}")
            differing_columns = [
                column for column in all_columns if column not in set(common_columns)
            ]
            if differing_columns:
                lines.append(f"Split-specific columns: {', '.join(differing_columns)}")
            lines.append("Column dtypes:")
            dtype_by_column: dict[str, str] = {}
            for table in self.tables:
                for name, dtype in table.dtypes.items():
                    dtype_by_column.setdefault(name, dtype)
            for name in all_columns:
                lines.append(f"  - {name}: {dtype_by_column.get(name, 'unknown')}")
        else:
            lines.append("- No split tables were profiled.")
        return self._append_warning_text("\n".join(lines))

    def _image_collection_summary(self) -> str:
        lines = ["Image collection dataset"]
        for collection in self.image_collections:
            lines.append(f"- Root: {collection.relative_root}")
            lines.append(f"- Total images: {collection.total_images}")
            lines.append(
                "Formats: "
                + ", ".join(
                    f"{suffix}={count}"
                    for suffix, count in sorted(collection.format_counts.items())
                )
            )
            lines.append(
                "Resolutions: "
                + ", ".join(
                    f"{resolution}={count}"
                    for resolution, count in sorted(
                        collection.resolution_counts.items()
                    )
                )
            )
            lines.append("Directory counts:")
            for directory, count in sorted(collection.directory_counts.items()):
                lines.append(f"- {directory}: {count} images")
        if not self.image_collections:
            lines.append("- No image files were profiled.")
        return self._append_warning_text("\n".join(lines))

    def _spreadsheet_workbook_summary(self) -> str:
        lines = ["Spreadsheet workbook dataset"]
        for workbook in self.spreadsheet_workbooks:
            lines.append(f"Workbook: {workbook.relative_path}")
            for sheet in workbook.sheets:
                lines.append(
                    f"- Sheet: {sheet.name} "
                    f"({sheet.rows} rows x {sheet.columns} columns; "
                    f"non-empty cells: {sheet.non_empty_cells}; "
                    f"formula cells: {sheet.formula_cells})"
                )
                lines.append("  Grid preview:")
                for row in sheet.preview_rows:
                    lines.append(f"  {row}")
        if not self.spreadsheet_workbooks:
            lines.append("- No spreadsheet workbook details were profiled.")
        return self._append_warning_text("\n".join(lines))

    def _fallback_summary(self) -> str:
        table_lines = [
            f"- {table.relative_path}: {table.rows} rows x {table.columns} columns; "
            f"columns={', '.join(table.column_names[:12])}"
            for table in self.tables
        ]
        if not table_lines:
            table_lines = ["- No tabular files were profiled."]
        file_lines = [
            f"- {file.relative_path}: {file.suffix or '<no suffix>'}, "
            f"{file.size_bytes} bytes"
            for file in self.files[:20]
        ]
        if not file_lines:
            file_lines = ["- No files discovered."]
        summary = "Mixed or unknown dataset\nFiles:\n"
        summary += "\n".join(file_lines)
        summary += "\nTables:\n" + "\n".join(table_lines)
        return self._append_warning_text(summary)

    def _append_warning_text(self, summary: str) -> str:
        warning_text = ""
        if self.warnings:
            warning_text = "\nWarnings:\n" + "\n".join(f"- {w}" for w in self.warnings)
        return summary + warning_text


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


class ReviewerPlanDecision(BaseModel):
    """Structured Reviewer decision for an Inspector planning response."""

    approved: bool = Field(description="Whether the plan is approved")
    reason: str = Field(description="Reviewer rationale for approving or rejecting")
    action_kind: ExplorationActionKind | None = Field(
        default=None, description="Approved exploration action kind, if any"
    )
    question: str = Field(
        default="", description="Specific question approved for the Coder"
    )
    evidence_needed: str = Field(
        default="", description="Evidence the approved code cell should produce"
    )
    coding_instruction: str = Field(
        default="", description="Concrete instruction for the Coder"
    )
    constraints: list[str] = Field(
        default_factory=list, description="Execution or analysis constraints"
    )

    @model_validator(mode="after")
    def validate_approved_payload(self) -> "ReviewerPlanDecision":
        if not self.approved:
            return self
        missing = []
        if self.action_kind is None:
            missing.append("action_kind")
        for name in ("question", "evidence_needed", "coding_instruction"):
            if not getattr(self, name).strip():
                missing.append(name)
        if missing:
            missing_text = ", ".join(missing)
            raise ValueError(f"approved plan requires: {missing_text}")
        return self


class FinalReviewDecision(BaseModel):
    """Structured Final Reviewer decision for an Inspector final draft."""

    approved: bool = Field(description="Whether the final draft is accepted")
    reason: str = Field(description="Reason for approval or rejection")
    additional_exploration_focus: str = Field(
        default="", description="Targeted focus for more exploration if rejected"
    )


class ApprovedCodeInstruction(BaseModel):
    """Coder-facing instruction assembled from an approved Reviewer decision."""

    action_kind: ExplorationActionKind = Field(
        description="Approved exploration action kind"
    )
    question: str = Field(description="Specific question the code should answer")
    evidence_needed: str = Field(description="Evidence the code should produce")
    coding_instruction: str = Field(description="Concrete instruction for the Coder")
    action_prompt: str = Field(description="Reusable DEA action prompt text")
    constraints: list[str] = Field(
        default_factory=list, description="Execution or analysis constraints"
    )


class DebugLesson(BaseModel):
    """Task-local debugging lesson that can guide later repair attempts."""

    error_pattern: str = Field(description="Recognizable error signature or symptom")
    root_cause: str = Field(description="Underlying cause of the failure")
    fix_strategy: str = Field(description="Reusable strategy that fixed the issue")
    applies_when: str = Field(description="Conditions where this lesson is relevant")


class ExplorationObservation(BaseModel):
    """Inspector-facing summary of a completed exploration cell result."""

    question: str = Field(description="Question the cell attempted to answer")
    purpose: str = Field(description="Why the cell was executed")
    stdout: str = Field(default="", description="Relevant standard output summary")
    artifacts: list[ArtifactRef] = Field(
        default_factory=list, description="Artifacts produced by the cell"
    )
    error_summary: str = Field(
        default="", description="Failure summary if the cell did not complete"
    )
    warning: str = Field(default="", description="Caveat or warning for Inspector")


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
    trace_events: list[TraceEvent] = Field(
        default_factory=list,
        description="Trace events emitted by the exploration orchestrator",
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


__all__ = [
    "ApprovedCodeInstruction",
    "ArtifactRef",
    "Budget",
    "CodeDraft",
    "Complexity",
    "DatasetKind",
    "DatasetProfile",
    "DebugDecision",
    "DebugLesson",
    "ExplorationAction",
    "ExplorationActionKind",
    "ExplorationObservation",
    "ExplorationReport",
    "ExplorationStep",
    "FinalDraft",
    "FinalReviewDecision",
    "ImageCollectionProfile",
    "InputFileInfo",
    "NotebookCell",
    "NotebookCellResult",
    "NotebookCodeContext",
    "NotebookState",
    "OutputBundle",
    "OutputStatus",
    "OutputType",
    "ReviewDecision",
    "ReviewerPlanDecision",
    "SpreadsheetSheetProfile",
    "SpreadsheetWorkbookProfile",
    "TableProfile",
    "TableRole",
    "TaskBrief",
    "TaskType",
    "TraceEvent",
    "budget_for_complexity",
]
