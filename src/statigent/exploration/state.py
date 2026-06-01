"""Typed LangGraph state for exploration orchestration."""

from typing import NotRequired, TypedDict

from statigent.schemas import (
    DatasetProfile,
    DebugLesson,
    ExplorationStep,
    FinalDraft,
    FinalReviewDecision,
    NotebookCell,
    NotebookCellResult,
    ReviewerPlanDecision,
    TaskBrief,
    TraceEvent,
)


class ExplorationRunState(TypedDict):
    """Mutable state passed between LangGraph exploration nodes."""

    brief: TaskBrief
    profile: DatasetProfile
    steps: list[ExplorationStep]
    pending_plan_text: str
    review_feedback: str
    approved_instruction: str | None
    last_cell_id: str
    debug_lessons: list[DebugLesson]
    final_draft: FinalDraft | None
    final_review: FinalReviewDecision | None
    warnings: list[str]
    trace_events: list[TraceEvent]
    round_count: int
    cell_count: int
    debug_attempts: int
    plan_review: NotRequired[ReviewerPlanDecision | None]
    last_cell: NotRequired[NotebookCell | None]
    last_result: NotRequired[NotebookCellResult | None]
    status: NotRequired[str]


def can_continue_exploration(state: ExplorationRunState) -> bool:
    """Return whether another Inspector planning round is still allowed."""
    return state["round_count"] < state["brief"].budgets.max_rounds


def can_append_cell(state: ExplorationRunState) -> bool:
    """Return whether another notebook code cell can be appended."""
    return state["cell_count"] < state["brief"].budgets.max_code_cells


def can_debug(state: ExplorationRunState) -> bool:
    """Return whether the current failed cell has debug retries remaining."""
    return state["debug_attempts"] < state["brief"].budgets.max_debug_attempts


__all__ = [
    "ExplorationRunState",
    "can_append_cell",
    "can_continue_exploration",
    "can_debug",
]
