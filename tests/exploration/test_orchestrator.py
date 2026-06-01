from pathlib import Path

from statigent.exploration import ExplorationOrchestrator
from statigent.exploration.state import ExplorationRunState
from statigent.notebook import FakeNotebookKernel, NotebookContext
from statigent.schemas import (
    ApprovedCodeInstruction,
    Complexity,
    DatasetProfile,
    DebugLesson,
    ExplorationActionKind,
    FinalDraft,
    FinalReviewDecision,
    InputFileInfo,
    NotebookCell,
    OutputType,
    ReviewerPlanDecision,
    TableProfile,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


class FakeInspector:
    def __init__(
        self,
        *,
        plans: list[str] | None = None,
        draft: FinalDraft | None = None,
    ) -> None:
        self.plans = plans or ["ACTION: summarize_numeric\nSTOP: no", "STOP: yes"]
        self.draft = draft or FinalDraft(
            content="Average revenue is 15.",
            evidence=["mean=15"],
        )
        self.calls: list[str] = []
        self.feedback_seen: list[str] = []
        self.last_usage_metadata = {
            "input_tokens": 10,
            "output_tokens": 4,
            "total_tokens": 14,
        }

    def next_plan(
        self,
        _brief: TaskBrief,
        _profile: DatasetProfile,
        _steps: object,
        reviewer_feedback: str,
    ) -> str:
        self.calls.append("next_plan")
        self.feedback_seen.append(reviewer_feedback)
        if self.plans:
            return self.plans.pop(0)
        return "STOP: yes"

    def final_draft(
        self,
        _brief: TaskBrief,
        _profile: DatasetProfile,
        _steps: object,
    ) -> FinalDraft:
        self.calls.append("final_draft")
        return self.draft


class FakeReviewer:
    def __init__(
        self,
        *,
        plan_decisions: list[ReviewerPlanDecision] | None = None,
        final_decisions: list[FinalReviewDecision] | None = None,
    ) -> None:
        self.plan_decisions = plan_decisions or [approved_plan()]
        self.final_decisions = final_decisions or [
            FinalReviewDecision(approved=True, reason="Complete")
        ]
        self.plans_seen: list[str] = []
        self.final_drafts_seen: list[FinalDraft] = []
        self.last_usage_metadata = {
            "input_tokens": 8,
            "output_tokens": 3,
            "total_tokens": 11,
        }

    def review_plan(
        self,
        _brief: TaskBrief,
        plan_text: str,
    ) -> ReviewerPlanDecision:
        self.plans_seen.append(plan_text)
        if self.plan_decisions:
            return self.plan_decisions.pop(0)
        return approved_plan()

    def review_final(
        self,
        _brief: TaskBrief,
        draft: FinalDraft,
    ) -> FinalReviewDecision:
        self.final_drafts_seen.append(draft)
        if self.final_decisions:
            return self.final_decisions.pop(0)
        return FinalReviewDecision(approved=True, reason="Complete")


class FakeCoder:
    def __init__(self) -> None:
        self.instructions: list[ApprovedCodeInstruction] = []
        self.last_usage_metadata = {
            "input_tokens": 12,
            "output_tokens": 6,
            "total_tokens": 18,
        }

    def append_code_cell(
        self,
        _brief: TaskBrief,
        _profile: DatasetProfile,
        instruction: ApprovedCodeInstruction,
        kernel: FakeNotebookKernel,
    ) -> NotebookCell:
        self.instructions.append(instruction)
        return kernel.append_code_cell(
            code="print('mean=15')",
            purpose=instruction.question,
            expected_observation=instruction.evidence_needed,
        )


class FakeDebugger:
    def __init__(self) -> None:
        self.lessons_seen: list[list[DebugLesson]] = []
        self.last_usage_metadata = {
            "input_tokens": 9,
            "output_tokens": 5,
            "total_tokens": 14,
        }

    def debug_cell(
        self,
        _brief: TaskBrief,
        kernel: FakeNotebookKernel,
        failed_cell: NotebookCell,
        error: str,
        lessons: list[DebugLesson],
    ) -> list[DebugLesson]:
        self.lessons_seen.append(list(lessons))
        lessons.append(
            DebugLesson(
                error_pattern=error,
                root_cause="Missing variable",
                fix_strategy="Define the missing variable",
                applies_when="NameError appears",
            )
        )
        kernel.replace_code_cell(
            failed_cell.cell_id,
            "print('fixed')",
            "Fix failed cell",
            "fixed",
        )
        return lessons


def approved_plan() -> ReviewerPlanDecision:
    return ReviewerPlanDecision(
        approved=True,
        reason="Relevant",
        action_kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
        question="What is average revenue?",
        evidence_needed="Mean revenue",
        coding_instruction="Compute the mean revenue.",
    )


def make_brief(
    *,
    max_rounds: int | None = None,
    max_code_cells: int | None = None,
    max_debug_attempts: int | None = None,
) -> TaskBrief:
    budget = budget_for_complexity(Complexity.SIMPLE)
    if max_rounds is not None:
        budget = budget.model_copy(update={"max_rounds": max_rounds})
    if max_code_cells is not None:
        budget = budget.model_copy(update={"max_code_cells": max_code_cells})
    if max_debug_attempts is not None:
        budget = budget.model_copy(update={"max_debug_attempts": max_debug_attempts})
    brief = TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        task_description=(
            "The user provided sales.csv with revenue data. Find average revenue."
        ),
        objective="Find average revenue",
        output_type=OutputType.ANSWER,
        complexity=Complexity.SIMPLE,
    )
    return brief.with_budget(budget)


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


def started_kernel(tmp_path: Path) -> FakeNotebookKernel:
    kernel = FakeNotebookKernel()
    kernel.start(
        NotebookContext(
            input_paths=[tmp_path / "sales.csv"],
            work_dir=tmp_path / "work",
        )
    )
    return kernel


def make_orchestrator(
    kernel: FakeNotebookKernel,
    *,
    inspector: FakeInspector | None = None,
    reviewer: FakeReviewer | None = None,
    coder: FakeCoder | None = None,
    debugger: FakeDebugger | None = None,
) -> ExplorationOrchestrator:
    return ExplorationOrchestrator(
        inspector=inspector or FakeInspector(),
        reviewer=reviewer or FakeReviewer(),
        coder=coder or FakeCoder(),
        debugger=debugger or FakeDebugger(),
        kernel=kernel,
    )


def make_state(
    tmp_path: Path,
    *,
    kernel: FakeNotebookKernel | None = None,
    debug_lessons: list[DebugLesson] | None = None,
) -> ExplorationRunState:
    cell = None
    if kernel is not None:
        cell = kernel.append_code_cell("print(missing)", "Fail", "error")
    return {
        "brief": make_brief(),
        "profile": make_profile(tmp_path),
        "steps": [],
        "pending_plan_text": "",
        "review_feedback": "",
        "approved_instruction": None,
        "last_cell_id": cell.cell_id if cell is not None else "",
        "debug_lessons": debug_lessons or [],
        "final_draft": None,
        "final_review": None,
        "warnings": [],
        "trace_events": [],
        "round_count": 0,
        "cell_count": 0,
        "debug_attempts": 0,
        "plan_review": None,
        "last_cell": cell,
        "last_result": None,
        "status": "",
    }


def test_reviewer_rejection_routes_back_to_inspector(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    inspector = FakeInspector(plans=["bad plan", "STOP: yes"])
    reviewer = FakeReviewer(
        plan_decisions=[
            ReviewerPlanDecision(approved=False, reason="Too broad"),
            approved_plan(),
        ]
    )
    orchestrator = make_orchestrator(
        kernel,
        inspector=inspector,
        reviewer=reviewer,
    )

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "success"
    assert inspector.calls == ["next_plan", "next_plan", "final_draft"]
    assert inspector.feedback_seen[1] == "Too broad"
    assert report.steps == []


def test_reviewer_approval_routes_to_coder_and_execute_by_cell_id(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    coder = FakeCoder()
    orchestrator = make_orchestrator(kernel, coder=coder)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert coder.instructions[0].action_prompt
    assert report.steps[0].result is not None
    assert report.steps[0].result.cell_id == "cell-1"
    assert kernel.snapshot().executed_cells[0].cell_id == "cell-1"


def test_custom_analysis_approval_records_required_action_fields(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="segments=3\n")
    reviewer = FakeReviewer(
        plan_decisions=[
            ReviewerPlanDecision(
                approved=True,
                reason="The task asks for hidden patterns.",
                action_kind=ExplorationActionKind.CUSTOM_ANALYSIS,
                question="Are there hidden revenue segments?",
                evidence_needed="Segment summary",
                coding_instruction="Cluster stores by revenue seasonality.",
                risk_notes="Clusters may overfit noisy history.",
            )
        ]
    )
    orchestrator = make_orchestrator(kernel, reviewer=reviewer)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    action = report.steps[0].action
    assert action.kind is ExplorationActionKind.CUSTOM_ANALYSIS
    assert action.rationale == "The task asks for hidden patterns."
    assert action.risk_notes == "Clusters may overfit noisy history."


def test_orchestrator_report_includes_langgraph_trace_events(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert [event.name for event in report.trace_events] == [
        "plan",
        "plan_approved",
        "append_code_cell",
        "execute_cell",
        "observe",
        "plan",
        "final_draft",
        "approved",
    ]
    assert all(event.agent and event.session == 1 for event in report.trace_events)


def test_orchestrator_trace_events_include_node_specific_payloads(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    plan = next(event for event in report.trace_events if event.name == "plan")
    reviewer = next(
        event for event in report.trace_events if event.name == "plan_approved"
    )
    coder = next(
        event for event in report.trace_events if event.name == "append_code_cell"
    )
    executor = next(
        event for event in report.trace_events if event.name == "execute_cell"
    )
    final_draft = next(
        event
        for event in report.trace_events
        if event.agent == "inspector" and event.name == "final_draft"
    )
    final_reviewer = next(
        event for event in report.trace_events if event.name == "approved"
    )

    assert plan.content == "ACTION: summarize_numeric\nSTOP: no"
    assert plan.usage_metadata["input_tokens"] == 10
    assert '"approved":true' in reviewer.content
    assert reviewer.usage_metadata["output_tokens"] == 3
    assert coder.content == "print('mean=15')"
    assert coder.usage_metadata["total_tokens"] == 18
    assert coder.metadata == {
        "cell_id": "cell-1",
        "code": "print('mean=15')",
        "purpose": "What is average revenue?",
        "expected_observation": "Mean revenue",
        "input_paths": [str(tmp_path / "sales.csv")],
    }
    assert executor.content == "mean=15\n"
    assert executor.metadata["cell_id"] == "cell-1"
    assert executor.metadata["code"] == "print('mean=15')"
    assert executor.metadata["exit_code"] == 0
    assert executor.usage_metadata == {}
    assert '"content":"Average revenue is 15."' in final_draft.content
    assert '"approved":true' in final_reviewer.content


def test_coder_appends_without_executing_then_execute_node_runs_cell(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    coder = FakeCoder()
    orchestrator = make_orchestrator(kernel, coder=coder)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert len(coder.instructions) == 1
    assert len(kernel.get_code_context().cells) == 1
    assert len(kernel.snapshot().executed_cells) == 1
    assert report.steps[0].result is not None
    assert report.steps[0].result.stdout == "mean=15\n"


def test_failed_execution_enters_debugger_and_retries_same_cell_id(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stderr="NameError", exit_code=1)
    kernel.queue_result(stdout="fixed\n", exit_code=0)
    debugger = FakeDebugger()
    orchestrator = make_orchestrator(kernel, debugger=debugger)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.steps[0].debug_attempts == 1
    assert [result.cell_id for result in kernel.snapshot().executed_cells] == [
        "cell-1",
        "cell-1",
    ]
    assert report.steps[0].result is not None
    assert report.steps[0].result.ok


def test_debug_trace_includes_failed_and_corrected_code(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stderr="NameError", exit_code=1)
    kernel.queue_result(stdout="fixed\n", exit_code=0)
    orchestrator = make_orchestrator(kernel, debugger=FakeDebugger())

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    debugger = next(
        event for event in report.trace_events if event.name == "debug_cell"
    )
    assert debugger.content == "print('fixed')"
    assert debugger.metadata["cell_id"] == "cell-1"
    assert debugger.metadata["failed_code"] == "print('mean=15')"
    assert debugger.metadata["corrected_code"] == "print('fixed')"
    assert debugger.metadata["error"] == "NameError"
    assert debugger.metadata["lessons"][0]["root_cause"] == "Missing variable"
    assert debugger.usage_metadata["input_tokens"] == 9


def test_debug_lessons_are_task_local_and_do_not_persist_across_runs(
    tmp_path: Path,
) -> None:
    first_kernel = started_kernel(tmp_path / "first")
    first_kernel.queue_result(stderr="NameError", exit_code=1)
    first_kernel.queue_result(stdout="fixed\n", exit_code=0)
    first_kernel.queue_result(stderr="NameError again", exit_code=1)
    first_kernel.queue_result(stdout="fixed again\n", exit_code=0)
    first_debugger = FakeDebugger()
    first = make_orchestrator(
        first_kernel,
        inspector=FakeInspector(
            plans=[
                "ACTION: summarize_numeric\nSTOP: no",
                "ACTION: summarize_numeric\nSTOP: no",
                "STOP: yes",
            ]
        ),
        debugger=first_debugger,
    )

    first.run(make_brief(), make_profile(tmp_path / "first"))

    assert first_debugger.lessons_seen[0] == []
    assert len(first_debugger.lessons_seen[1]) == 1

    second_kernel = started_kernel(tmp_path / "second")
    second_kernel.queue_result(stderr="NameError", exit_code=1)
    second_kernel.queue_result(stdout="fixed\n", exit_code=0)
    second_debugger = FakeDebugger()
    second = make_orchestrator(second_kernel, debugger=second_debugger)

    second.run(make_brief(), make_profile(tmp_path / "second"))

    assert second_debugger.lessons_seen[0] == []


def test_final_review_rejection_routes_back_to_inspector_when_budget_remains(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    kernel.queue_result(stdout="count=2\n")
    inspector = FakeInspector(
        plans=[
            "ACTION: summarize_numeric\nSTOP: no",
            "STOP: yes",
            "ACTION: summarize_numeric\nSTOP: no",
            "STOP: yes",
        ],
        draft=FinalDraft(content="Average revenue is 15.", evidence=["mean=15"]),
    )
    reviewer = FakeReviewer(
        final_decisions=[
            FinalReviewDecision(
                approved=False,
                reason="Need clearer evidence",
                additional_exploration_focus="Show the exact calculation.",
            ),
            FinalReviewDecision(approved=True, reason="Complete"),
        ]
    )
    orchestrator = make_orchestrator(
        kernel,
        inspector=inspector,
        reviewer=reviewer,
    )

    report = orchestrator.run(make_brief(max_rounds=4), make_profile(tmp_path))

    assert report.status == "success"
    assert inspector.feedback_seen[2] == "Show the exact calculation."
    assert len(reviewer.final_drafts_seen) == 2
    assert len(report.steps) == 2
    assert len(kernel.snapshot().executed_cells) == 2


def test_round_budget_exhaustion_produces_partial_output(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(
        kernel,
        inspector=FakeInspector(plans=["ACTION: summarize_numeric\nSTOP: no"]),
        reviewer=FakeReviewer(
            final_decisions=[
                FinalReviewDecision(
                    approved=False,
                    reason="Incomplete",
                    additional_exploration_focus="Need more evidence.",
                )
            ]
        ),
    )

    report = orchestrator.run(
        make_brief(max_rounds=1),
        make_profile(tmp_path),
    )

    assert report.status == "partial"
    assert any(
        "final review did not approve" in warning.lower() for warning in report.warnings
    )


def test_exact_round_budget_with_approved_final_review_returns_success(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(
        kernel,
        inspector=FakeInspector(plans=["ACTION: summarize_numeric\nSTOP: no"]),
    )

    report = orchestrator.run(
        make_brief(max_rounds=1),
        make_profile(tmp_path),
    )

    assert report.status == "success"
    assert len(report.steps) == 1
    assert len(kernel.snapshot().executed_cells) == 1


def test_code_cell_budget_exhaustion_produces_partial_output(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(
        kernel,
        inspector=FakeInspector(
            plans=[
                "ACTION: summarize_numeric\nSTOP: no",
                "ACTION: summarize_numeric\nSTOP: no",
            ]
        ),
    )

    report = orchestrator.run(
        make_brief(max_code_cells=1),
        make_profile(tmp_path),
    )

    assert report.status == "partial"
    assert len(report.steps) == 1
    assert len(kernel.snapshot().executed_cells) == 1
    assert any(
        "code cell budget exhausted" in warning.lower() for warning in report.warnings
    )


def test_debug_budget_exhaustion_produces_partial_output(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stderr="NameError", exit_code=1)
    kernel.queue_result(stderr="NameError again", exit_code=1)
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(
        make_brief(max_debug_attempts=1),
        make_profile(tmp_path),
    )

    assert report.status == "partial"
    assert report.steps[0].debug_attempts == 1
    assert report.steps[0].result is not None
    assert not report.steps[0].result.ok
    assert any(
        "debug budget exhausted" in warning.lower() for warning in report.warnings
    )


def test_invalid_approved_plan_without_instruction_routes_to_inspector(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    orchestrator = make_orchestrator(kernel)
    invalid_decision = ReviewerPlanDecision.model_construct(
        approved=True,
        reason="Missing action",
        action_kind=None,
        question="",
        evidence_needed="",
        coding_instruction="",
        constraints=[],
    )
    state = make_state(tmp_path)
    state["plan_review"] = invalid_decision
    state["approved_instruction"] = None

    route = orchestrator._route_after_plan_review(state)

    assert route == "inspector"


def test_debug_node_returns_new_lesson_list_without_mutating_state(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stderr="NameError", exit_code=1)
    original_lesson = DebugLesson(
        error_pattern="KeyError",
        root_cause="Missing key",
        fix_strategy="Check key before access",
        applies_when="Dictionary lookup fails",
    )
    state = make_state(tmp_path, kernel=kernel, debug_lessons=[original_lesson])
    assert state["last_cell_id"]
    result = kernel.execute_cell(state["last_cell_id"])
    state["last_result"] = result
    orchestrator = make_orchestrator(kernel, debugger=FakeDebugger())

    updates = orchestrator._debug_node(state)

    updated_lessons = updates["debug_lessons"]
    assert isinstance(updated_lessons, list)
    assert updated_lessons is not state["debug_lessons"]
    assert state["debug_lessons"] == [original_lesson]
    assert len(updated_lessons) == 2


def test_final_review_approval_produces_success_output(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "success"
    assert report.final_draft.content == "Average revenue is 15."
    assert not report.final_draft.warnings
