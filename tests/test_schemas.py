from pathlib import Path

import pytest
from pydantic import ValidationError

from statigent.schemas import (
    ArtifactRef,
    Budget,
    Complexity,
    DatasetKind,
    DatasetProfile,
    DebugLesson,
    ExplorationAction,
    ExplorationActionKind,
    ExplorationReport,
    FinalDraft,
    InputFileInfo,
    OutputBundle,
    OutputStatus,
    OutputType,
    ReviewerPlanDecision,
    TableProfile,
    TaskBrief,
    TaskType,
    TraceEvent,
    budget_for_complexity,
)


def test_budget_for_complexity_uses_fixed_system_tiers() -> None:
    assert budget_for_complexity(Complexity.SIMPLE) == Budget(
        max_rounds=10,
        max_code_cells=20,
        max_debug_attempts=5,
        timeout_seconds=180,
    )
    assert budget_for_complexity(Complexity.MODERATE) == Budget(
        max_rounds=20,
        max_code_cells=40,
        max_debug_attempts=8,
        timeout_seconds=600,
    )
    assert budget_for_complexity(Complexity.COMPLEX) == Budget(
        max_rounds=35,
        max_code_cells=70,
        max_debug_attempts=12,
        timeout_seconds=1200,
    )


def test_task_brief_field_descriptions_define_what_not_how() -> None:
    schema = TaskBrief.model_json_schema()
    task_type_description = schema["properties"]["task_type"]["description"]
    task_description = schema["properties"]["task_description"]["description"]
    output_type_description = schema["properties"]["output_type"]["description"]
    complexity_description = schema["properties"]["complexity"]["description"]

    assert set(schema["properties"]) == {
        "task_type",
        "task_description",
        "objective",
        "output_type",
        "complexity",
    }
    assert "category" in task_type_description.casefold()
    assert "complete description" in task_description.casefold()
    assert "shape" in output_type_description.casefold()
    assert "effort tier" in complexity_description.casefold()
    assert "choose when" not in task_type_description.casefold()
    assert "analyze by" not in complexity_description.casefold()
    assert "data_context" not in schema["properties"]
    assert "analysis_hints" not in schema["properties"]
    assert "warnings" not in schema["properties"]


def test_task_brief_supports_deep_analysis() -> None:
    brief = TaskBrief(
        task_type=TaskType.DEEP_ANALYSIS,
        task_description="The user wants an executive report from sales.csv.",
        objective="Create an executive sales report",
        output_type=OutputType.REPORT,
        complexity=Complexity.COMPLEX,
    )

    assert brief.task_type is TaskType.DEEP_ANALYSIS
    assert brief.budgets.max_rounds == 35


def test_trace_event_requires_agent_and_session() -> None:
    event = TraceEvent(
        role="assistant",
        content="planned",
        name="task_brief",
        agent="task_brief_planner",
        session=1,
    )

    assert event.model_dump()["agent"] == "task_brief_planner"
    assert event.model_dump()["session"] == 1


def test_trace_event_exposes_usage_metadata_for_token_accounting() -> None:
    event = TraceEvent(
        role="assistant",
        content="planned",
        name="plan",
        agent="inspector",
        usage_metadata={
            "input_tokens": 12,
            "output_tokens": 5,
            "total_tokens": 17,
        },
    )

    assert event.model_dump()["usage_metadata"] == {
        "input_tokens": 12,
        "output_tokens": 5,
        "total_tokens": 17,
    }


def test_exploration_report_exposes_trace_events() -> None:
    report = ExplorationReport(
        status="success",
        final_draft=FinalDraft(content="Done"),
        steps=[],
        artifacts=[],
    )

    assert report.trace_events == []


def test_reviewer_plan_decision_allows_rejection_without_action() -> None:
    decision = ReviewerPlanDecision(approved=False, reason="Redundant")

    assert decision.action_kind is None
    assert decision.constraints == []


def test_reviewer_plan_decision_allows_complete_approval() -> None:
    decision = ReviewerPlanDecision(
        approved=True,
        reason="Relevant next step",
        action_kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
        question="What is the revenue distribution?",
        evidence_needed="Summary statistics for revenue",
        coding_instruction="Compute descriptive statistics for revenue.",
        constraints=["Use profiled table names only"],
    )

    assert decision.action_kind is ExplorationActionKind.SUMMARIZE_NUMERIC
    assert decision.question == "What is the revenue distribution?"


def test_reviewer_plan_decision_rejects_approval_without_payload() -> None:
    with pytest.raises(ValidationError, match="approved plan requires"):
        ReviewerPlanDecision(approved=True, reason="Relevant next step")


def test_debug_lesson_records_task_local_fix() -> None:
    lesson = DebugLesson(
        error_pattern="NameError",
        root_cause="Column variable was misspelled",
        fix_strategy="Use df.columns to confirm names",
        applies_when="Column access fails",
    )

    assert lesson.error_pattern == "NameError"
    assert lesson.fix_strategy == "Use df.columns to confirm names"


def test_custom_action_requires_rationale_expected_evidence_and_risk_notes() -> None:
    with pytest.raises(ValidationError):
        ExplorationAction(
            kind=ExplorationActionKind.CUSTOM_ANALYSIS,
            title="Try unusual segmentation",
            description="Cluster stores by seasonality",
        )

    action = ExplorationAction(
        kind=ExplorationActionKind.CUSTOM_ANALYSIS,
        title="Try unusual segmentation",
        description="Cluster stores by seasonality",
        rationale="The prompt asks for hidden patterns",
        expected_evidence="A compact segment summary",
        risk_notes="May overfit noisy history",
    )

    assert action.kind is ExplorationActionKind.CUSTOM_ANALYSIS


def test_dataset_profile_records_table_and_non_table_files(tmp_path: Path) -> None:
    profile = DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=tmp_path / "sales.csv",
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=12,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=tmp_path / "sales.csv",
                relative_path="sales.csv",
                rows=2,
                columns=2,
                column_names=["date", "revenue"],
                dtypes={"date": "object", "revenue": "int64"},
                missing_rates={"date": 0.0, "revenue": 0.0},
                unique_counts={"date": 2, "revenue": 2},
                numeric_summaries={"revenue": {"mean": 15.0}},
                likely_time_columns=["date"],
                likely_categorical_columns=[],
                sample_rows=[{"date": "2026-01-01", "revenue": 10}],
                warnings=[],
            )
        ],
        warnings=[],
    )

    assert profile.tables[0].rows == 2
    assert "sales.csv" in profile.compact_summary()


def test_dataset_profile_mixed_summary_prefers_input_paths(tmp_path: Path) -> None:
    profile = DatasetProfile(
        root=tmp_path,
        input_paths=[Path("inputs")],
        kind=DatasetKind.MIXED,
        files=[
            InputFileInfo(
                path=tmp_path / "inputs" / "notes.txt",
                relative_path="inputs/notes.txt",
                suffix=".txt",
                size_bytes=12,
                is_tabular=False,
            )
        ],
        tables=[],
        warnings=[],
    )

    summary = profile.compact_summary()

    assert "Data files:\n- inputs" in summary
    assert "inputs/notes.txt: .txt" not in summary


def test_output_bundle_has_status_content_and_artifacts(tmp_path: Path) -> None:
    bundle = OutputBundle(
        status=OutputStatus.SUCCESS,
        output_type=OutputType.FILE,
        content="Generated cleaned data",
        artifacts=[
            ArtifactRef(
                name="clean.csv",
                path=tmp_path / "clean.csv",
                kind="table",
                description="Cleaned table",
            )
        ],
        warnings=[],
        trace_summary="1 cell executed",
    )

    assert bundle.artifacts[0].name == "clean.csv"
