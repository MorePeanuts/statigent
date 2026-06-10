import inspect
from pathlib import Path

from langgraph.types import Command

from statigent.errors import StatigentExplorationError
from statigent.exploration import ExplorationOrchestrator
from statigent.exploration.actors import CoderExecutionOutcome, DebugExecutionOutcome
from statigent.exploration.state import ExplorationRunState
from statigent.notebook import FakeNotebookKernel, NotebookContext
from statigent.schemas import (
    Complexity,
    DatasetProfile,
    DebugLesson,
    FinalDraft,
    InputFileInfo,
    NotebookCell,
    OutputType,
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
        self.plans = plans or [
            "ACTION: summarize_numeric\nCODER_INSTRUCTION: Compute mean revenue.",
            "DONE",
        ]
        self.draft = draft or FinalDraft(
            content="Average revenue is 15.",
            evidence=["mean=15"],
        )
        self.calls: list[str] = []
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
    ) -> str:
        self.calls.append("next_plan")
        if self.plans:
            return self.plans.pop(0)
        return "DONE"

    def final_draft(
        self,
        _brief: TaskBrief,
        _profile: DatasetProfile,
        _steps: object,
    ) -> FinalDraft:
        self.calls.append("final_draft")
        return self.draft


class FakeCoder:
    def __init__(self, kernel: FakeNotebookKernel | None = None) -> None:
        self.kernel = kernel
        self.instructions: list[str] = []
        self.last_usage_metadata = {
            "input_tokens": 12,
            "output_tokens": 6,
            "total_tokens": 18,
        }

    def append_and_execute(
        self,
        _profile: DatasetProfile,
        instruction: str,
    ) -> CoderExecutionOutcome:
        self.instructions.append(instruction)
        if self.kernel is None:
            raise AssertionError("FakeCoder.kernel must be set before use")
        cell = self.kernel.append_code_cell(
            code="print('mean=15')",
            purpose="Inspector-directed exploration",
            expected_observation="Evidence requested by Inspector",
        )
        result = self.kernel.execute_cell(cell.cell_id)
        return CoderExecutionOutcome(
            cell=cell,
            result=result,
            observation=f"Observation:\n{result.stdout or result.stderr}",
        )

    @staticmethod
    def observation_for_result(
        _instruction: str,
        _cell: NotebookCell,
        result: object,
    ) -> str:
        return f"Observation:\n{getattr(result, 'stdout', '')}"


class FailingCoder(FakeCoder):
    def append_and_execute(
        self,
        _profile: DatasetProfile,
        instruction: str,
    ) -> CoderExecutionOutcome:
        self.instructions.append(instruction)
        raise StatigentExplorationError("Coder agent did not call append_code_cell.")


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
    ) -> DebugExecutionOutcome:
        self.lessons_seen.append(list(lessons))
        lessons.append(
            DebugLesson(
                error_pattern=error,
                root_cause="Missing variable",
                fix_strategy="Define the missing variable",
                applies_when="NameError appears",
            )
        )
        cell = kernel.replace_code_cell(
            failed_cell.cell_id,
            "print('fixed')",
            "Fix failed cell",
            "fixed",
        )
        result = kernel.execute_cell(cell.cell_id)
        return DebugExecutionOutcome(cell=cell, result=result, lessons=list(lessons))


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
    coder: FakeCoder | None = None,
    debugger: FakeDebugger | None = None,
) -> ExplorationOrchestrator:
    run_coder = coder or FakeCoder(kernel)
    run_coder.kernel = kernel
    return ExplorationOrchestrator(
        inspector=inspector or FakeInspector(),
        coder=run_coder,
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
        "approved_instruction": None,
        "last_cell_id": cell.cell_id if cell is not None else "",
        "debug_lessons": debug_lessons or [],
        "final_draft_requested": False,
        "final_draft": None,
        "warnings": [],
        "trace_events": [],
        "round_count": 0,
        "cell_count": 0,
        "debug_attempts": 0,
        "last_cell": cell,
        "last_result": None,
        "status": "",
    }


def test_graph_nodes_use_command_goto_for_routing() -> None:
    source = inspect.getsource(ExplorationOrchestrator._build_graph)

    assert "add_conditional_edges" not in source
    assert source.count("add_edge") == 1
    assert '"review_plan"' not in source
    assert '"final_review"' not in source


def test_inspector_instruction_routes_directly_to_coder(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    inspector = FakeInspector(
        plans=[
            "ACTION: summarize_numeric\n"
            "QUESTION: What is average revenue?\n"
            "EVIDENCE_NEEDED: Mean revenue\n"
            "CODER_INSTRUCTION: Compute mean revenue directly."
        ]
    )
    coder = FakeCoder()
    orchestrator = make_orchestrator(kernel, inspector=inspector, coder=coder)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert coder.instructions == ["Compute mean revenue directly."]
    assert report.status == "success"
    assert len(report.steps) == 1
    assert report.steps[0].review.reason == "Directed by Inspector"
    assert [event.name for event in report.trace_events] == [
        "plan",
        "append_code_cell",
        "observation",
        "plan",
        "final_draft",
    ]


def test_done_finalizes_without_code_or_review(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    inspector = FakeInspector(plans=["DONE"])
    coder = FakeCoder()
    orchestrator = make_orchestrator(kernel, inspector=inspector, coder=coder)

    report = orchestrator.run(make_brief(max_rounds=1), make_profile(tmp_path))

    assert report.status == "success"
    assert inspector.calls == ["next_plan", "final_draft"]
    assert coder.instructions == []
    assert [event.agent for event in report.trace_events] == ["inspector", "inspector"]
    assert [event.name for event in report.trace_events] == ["plan", "final_draft"]


def test_done_with_instruction_executes_instruction_and_warns(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    inspector = FakeInspector(
        plans=[
            "ACTION: summarize_numeric\n"
            "CODER_INSTRUCTION: Compute mean revenue directly.\n"
            "DONE"
        ]
    )
    coder = FakeCoder()
    orchestrator = make_orchestrator(kernel, inspector=inspector, coder=coder)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert coder.instructions == ["Compute mean revenue directly."]
    assert any("DONE ignored" in warning for warning in report.warnings)


def test_freeform_plan_records_action_fields(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="segments=3\n")
    inspector = FakeInspector(
        plans=[
            "ACTION: segment_revenue\n"
            "QUESTION: Are there hidden revenue segments?\n"
            "EVIDENCE_NEEDED: Segment summary\n"
            "CODER_INSTRUCTION: Segment revenue."
        ]
    )
    orchestrator = make_orchestrator(kernel, inspector=inspector)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    action = report.steps[0].action
    assert action.title == "Are there hidden revenue segments?"
    assert action.description.startswith("ACTION: segment_revenue")
    assert action.rationale == "Inspector-directed exploration"
    assert action.expected_evidence == "Segment summary"
    assert action.risk_notes == ""


def test_trace_events_include_node_specific_payloads(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    plan = next(event for event in report.trace_events if event.name == "plan")
    coder = next(
        event for event in report.trace_events if event.name == "append_code_cell"
    )
    observation = next(
        event for event in report.trace_events if event.name == "observation"
    )
    final_draft = next(
        event
        for event in report.trace_events
        if event.agent == "inspector" and event.name == "final_draft"
    )

    assert plan.content == (
        "ACTION: summarize_numeric\nCODER_INSTRUCTION: Compute mean revenue."
    )
    assert plan.usage_metadata["input_tokens"] == 10
    assert coder.content == "print('mean=15')"
    assert coder.usage_metadata["total_tokens"] == 18
    assert coder.metadata == {
        "cell_id": "cell-1",
        "code": "print('mean=15')",
        "purpose": "Inspector-directed exploration",
        "expected_observation": "Evidence requested by Inspector",
        "input_paths": [str(tmp_path / "sales.csv")],
    }
    assert "Observation:" in observation.content
    assert observation.metadata["cell_id"] == "cell-1"
    assert observation.metadata["code"] == "print('mean=15')"
    assert observation.metadata["exit_code"] == 0
    assert observation.usage_metadata == {}
    assert '"content":"Average revenue is 15."' in final_draft.content
    assert all(event.agent != "reviewer" for event in report.trace_events)
    assert all(event.agent != "final_reviewer" for event in report.trace_events)


def test_coder_appends_and_code_node_executes_cell(tmp_path: Path) -> None:
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


def test_coder_protocol_failure_returns_partial_report(tmp_path: Path) -> None:
    kernel = started_kernel(tmp_path)
    coder = FailingCoder()
    orchestrator = make_orchestrator(kernel, coder=coder)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "partial"
    assert coder.instructions == ["Compute mean revenue."]
    assert report.steps == []
    assert any(
        "coder failed to execute approved instruction" in warning.casefold()
        for warning in report.warnings
    )
    assert any(
        event.agent == "coder" and event.name == "protocol_error"
        for event in report.trace_events
    )


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
                "ACTION: summarize_numeric\nCODER_INSTRUCTION: Compute mean.",
                "ACTION: summarize_numeric\nCODER_INSTRUCTION: Validate mean.",
                "DONE",
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


def test_round_budget_exhaustion_after_completed_step_returns_success(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(
        kernel,
        inspector=FakeInspector(
            plans=["ACTION: summarize_numeric\nCODER_INSTRUCTION: Compute mean."]
        ),
    )

    report = orchestrator.run(
        make_brief(max_rounds=1),
        make_profile(tmp_path),
    )

    assert report.status == "success"
    assert len(report.steps) == 1
    assert any(
        "round budget reached" in event.metadata.get("reason", "").casefold()
        for event in report.trace_events
        if event.name == "final_draft"
    )


def test_code_cell_budget_exhaustion_produces_partial_output(
    tmp_path: Path,
) -> None:
    kernel = started_kernel(tmp_path)
    kernel.queue_result(stdout="mean=15\n")
    orchestrator = make_orchestrator(
        kernel,
        inspector=FakeInspector(
            plans=[
                "ACTION: summarize_numeric\nCODER_INSTRUCTION: Compute mean.",
                "ACTION: summarize_numeric\nCODER_INSTRUCTION: Validate mean.",
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


def test_debug_budget_exhaustion_produces_partial_output(tmp_path: Path) -> None:
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

    command = orchestrator._debug_node(state)
    updates = command.update

    assert isinstance(command, Command)
    assert command.goto == "inspector"
    updated_lessons = updates["debug_lessons"]
    assert isinstance(updated_lessons, list)
    assert updated_lessons is not state["debug_lessons"]
    assert state["debug_lessons"] == [original_lesson]
    assert len(updated_lessons) == 2
