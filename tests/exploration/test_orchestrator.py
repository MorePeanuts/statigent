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


def make_orchestrator(
    kernel: FakeNotebookKernel,
    *,
    final_approved: bool = True,
) -> ExplorationOrchestrator:
    return ExplorationOrchestrator(
        inspector=FakeInspector(),
        reviewer=FakeReviewer(final_approved=final_approved),
        coder=FakeCoder(),
        debugger=FakeDebugger(),
        kernel=kernel,
    )


def test_orchestrator_runs_action_and_returns_report(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="mean=15\n")
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "success"
    assert report.final_draft.content == "Average revenue is 15."
    assert len(report.steps) == 1


def test_orchestrator_debugs_failed_cell(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stderr="NameError", exit_code=1)
    kernel.queue_result(stdout="fixed\n", exit_code=0)
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    orchestrator = make_orchestrator(kernel)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.steps[0].debug_attempts == 1
    assert report.steps[0].result is not None
    assert report.steps[0].result.ok


def test_orchestrator_returns_partial_when_final_review_fails(
    tmp_path: Path,
) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="mean=15\n")
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    orchestrator = make_orchestrator(kernel, final_approved=False)

    report = orchestrator.run(make_brief(), make_profile(tmp_path))

    assert report.status == "partial"
    assert report.warnings
