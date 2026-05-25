from statigent.output import OutputRenderer
from statigent.schemas import (
    Complexity,
    ExplorationAction,
    ExplorationActionKind,
    ExplorationReport,
    ExplorationStep,
    FinalDraft,
    OutputStatus,
    OutputType,
    ReviewDecision,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


def make_brief(task_type: TaskType, output_type: OutputType) -> TaskBrief:
    return TaskBrief(
        task_type=task_type,
        background="The user provided sales.csv.",
        question="Analyze sales.",
        objective="Analyze sales",
        output_type=output_type,
        requirements=[],
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
    bundle = OutputRenderer().render(
        make_brief(TaskType.DATA_ANALYSIS, OutputType.ANSWER),
        make_report(),
    )

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

    bundle = OutputRenderer().render(
        make_brief(TaskType.DATA_ANALYSIS, OutputType.REPORT),
        report,
    )

    assert bundle.status is OutputStatus.PARTIAL
    assert bundle.warnings == ["Budget exhausted"]


def test_renderer_handles_langgraph_exploration_report_shape() -> None:
    report = ExplorationReport(
        status="success",
        final_draft=FinalDraft(
            content="Average revenue is 15.",
            evidence=["mean=15"],
            warnings=["Small sample"],
        ),
        steps=[
            ExplorationStep(
                action=ExplorationAction(
                    kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
                    title="Average revenue",
                    description="Compute mean revenue",
                ),
                review=ReviewDecision(approved=True, reason="Relevant"),
            )
        ],
        artifacts=[],
        warnings=["Small sample"],
    )

    bundle = OutputRenderer().render(
        make_brief(TaskType.DATA_ANALYSIS, OutputType.REPORT),
        report,
    )

    assert bundle.status is OutputStatus.SUCCESS
    assert bundle.content == "Average revenue is 15."
    assert bundle.trace_summary == "1 exploration step(s)"
