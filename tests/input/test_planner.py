from pathlib import Path

import pytest
from langchain_core.exceptions import OutputParserException

from statigent.input import TaskBriefPlanner
from statigent.schemas import (
    Budget,
    Complexity,
    DatasetProfile,
    InputFileInfo,
    OutputType,
    TableProfile,
    TaskBrief,
    TaskType,
)


class FakeStructuredModel:
    def __init__(self, result: TaskBrief | Exception) -> None:
        self.result = result

    def invoke(self, _messages: list[dict[str, str]]) -> TaskBrief:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class FakeModel:
    def __init__(self, result: TaskBrief | Exception) -> None:
        self.result = result

    def with_structured_output(self, _schema: type[TaskBrief]) -> FakeStructuredModel:
        return FakeStructuredModel(self.result)


def make_profile(tmp_path: Path) -> DatasetProfile:
    table = tmp_path / "sales.csv"
    return DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=table,
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=10,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=table,
                relative_path="sales.csv",
                rows=2,
                columns=2,
                column_names=["date", "revenue"],
                dtypes={"date": "object", "revenue": "int64"},
                missing_rates={"date": 0.0, "revenue": 0.0},
                unique_counts={"date": 2, "revenue": 2},
                numeric_summaries={"revenue": {"mean": 12.0}},
                likely_time_columns=["date"],
                likely_categorical_columns=[],
                sample_rows=[],
            )
        ],
        warnings=[],
    )


def test_planner_uses_structured_model_result(tmp_path: Path) -> None:
    expected = TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        objective="Analyze revenue trend",
        output_type=OutputType.REPORT,
        requirements=["Mention trend"],
        data_context="sales.csv",
        complexity=Complexity.MODERATE,
        budgets=Budget(
            max_rounds=5,
            max_code_cells=10,
            max_debug_attempts=2,
            timeout_seconds=300,
        ),
    )
    planner = TaskBriefPlanner(model=FakeModel(expected))

    brief = planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief == expected


def test_planner_fallback_detects_deep_analysis(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(OutputParserException("bad json")))

    brief = planner.create_brief(
        prompt="Create a deep business analysis report for sales executives",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.task_type is TaskType.DEEP_ANALYSIS
    assert brief.output_type is OutputType.REPORT
    assert brief.warnings


def test_planner_fallback_detects_modeling(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(OutputParserException("bad json")))

    brief = planner.create_brief(
        prompt="Build a predictive model and forecast next month's demand",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.task_type is TaskType.DATA_MODELING
    assert brief.output_type is OutputType.FILE
    assert brief.complexity is Complexity.COMPLEX
    assert any("parsing failure" in warning for warning in brief.warnings)
    assert any("fallback" in warning for warning in brief.warnings)


def test_planner_fallback_handles_structured_output_exception(
    tmp_path: Path,
) -> None:
    planner = TaskBriefPlanner(model=FakeModel(OutputParserException("bad json")))

    brief = planner.create_brief(
        prompt="Summarize the dataset",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.task_type is TaskType.DATA_ANALYSIS
    assert brief.output_type is OutputType.ANSWER
    assert brief.warnings


def test_planner_unexpected_programmer_error_propagates(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(TypeError("programmer bug")))

    with pytest.raises(TypeError, match="programmer bug"):
        planner.create_brief(
            prompt="Analyze revenue trend",
            task_instructions="",
            profile=make_profile(tmp_path),
        )
