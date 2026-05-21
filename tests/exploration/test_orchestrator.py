from pathlib import Path

from statigent.exploration import ExplorationOrchestrator
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

    def append_code_cell(
        self,
        _brief: TaskBrief,
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
    return TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        objective="Find average revenue",
        output_type=OutputType.ANSWER,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.SIMPLE,
        budgets=budget,
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


def started_kernel(tmp_path: Path) -> FakeNotebookKernel:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
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
    assert any("budget exhausted" in warning.lower() for warning in report.warnings)


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
        "code cell budget exhausted" in warning.lower()
        for warning in report.warnings
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
        "debug budget exhausted" in warning.lower()
        for warning in report.warnings
    )


def test_final_review_approval_produces_success_output(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "success"
    assert report.final_draft.content == "Average revenue is 15."
    assert not report.final_draft.warnings
