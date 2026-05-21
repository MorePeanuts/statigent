from pathlib import Path
from typing import Any

import pytest

from statigent.errors import StatigentParseError
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
    budget_for_complexity,
)


def _make_raw_result(
    parsed: object = None, parsing_error: object = None
) -> dict[str, Any]:
    return {"raw": None, "parsed": parsed, "parsing_error": parsing_error}


class FakeStructuredModel:
    def __init__(
        self, result: object = None, parsing_error: Exception | None = None
    ) -> None:
        self.result = result
        self.parsing_error = parsing_error

    def invoke(self, _messages: list[dict[str, str]]) -> dict[str, Any]:
        return _make_raw_result(parsed=self.result, parsing_error=self.parsing_error)


class FakeModel:
    def __init__(
        self,
        result: object = None,
        parsing_error: Exception | None = None,
    ) -> None:
        self.result = result
        self.parsing_error = parsing_error

    def with_structured_output(
        self, _schema: type[TaskBrief], *, include_raw: bool = False
    ) -> FakeStructuredModel:
        return FakeStructuredModel(self.result, self.parsing_error)


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
            max_rounds=7,
            max_code_cells=14,
            max_debug_attempts=3,
            timeout_seconds=480,
        ),
    )
    planner = TaskBriefPlanner(model=FakeModel(expected))

    brief = planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief == expected


def test_planner_raises_parse_error_for_structured_output_error(
    tmp_path: Path,
) -> None:
    planner = TaskBriefPlanner(model=FakeModel(parsing_error=ValueError("bad json")))

    with pytest.raises(StatigentParseError):
        planner.create_brief(
            prompt="Summarize the dataset",
            task_instructions="",
            profile=make_profile(tmp_path),
        )


def test_planner_raises_parse_error_for_wrong_parsed_type(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(result="not a task brief"))

    with pytest.raises(StatigentParseError):
        planner.create_brief(
            prompt="Analyze revenue trend",
            task_instructions="",
            profile=make_profile(tmp_path),
        )


def test_planner_derives_budget_from_complexity(tmp_path: Path) -> None:
    expected = TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        objective="Analyze revenue trend",
        output_type=OutputType.REPORT,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.MODERATE,
        budgets=Budget(
            max_rounds=1,
            max_code_cells=1,
            max_debug_attempts=0,
            timeout_seconds=1,
        ),
    )
    planner = TaskBriefPlanner(model=FakeModel(expected))

    brief = planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.budgets == budget_for_complexity(Complexity.MODERATE)
