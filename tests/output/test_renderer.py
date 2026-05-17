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
