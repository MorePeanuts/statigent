from pathlib import Path
from typing import Any

import pytest
from langchain.messages import AIMessage
from pydantic import BaseModel

from statigent.errors import StatigentParseError
from statigent.input import TaskBriefPlanner
from statigent.schemas import (
    Complexity,
    DatasetProfile,
    InputFileInfo,
    OutputType,
    TableProfile,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)

_UNSET = object()


def _make_raw_result(
    parsed: object = None,
    parsing_error: object = None,
    raw: object = None,
) -> dict[str, Any]:
    return {"raw": raw, "parsed": parsed, "parsing_error": parsing_error}


class FakeStructuredModel:
    def __init__(
        self,
        result: object = None,
        parsing_error: Exception | None = None,
        usage_metadata: dict[str, int] | None = None,
    ) -> None:
        self.result = result
        self.parsing_error = parsing_error
        self.usage_metadata = usage_metadata

    def invoke(self, _messages: list[dict[str, str]]) -> dict[str, Any]:
        raw = (
            AIMessage(content="", usage_metadata=self.usage_metadata)
            if self.usage_metadata is not None
            else None
        )
        return _make_raw_result(
            parsed=self.result,
            parsing_error=self.parsing_error,
            raw=raw,
        )


class FakeModel:
    def __init__(
        self,
        result: object = _UNSET,
        payload: dict[str, object] | None = None,
        parsing_error: Exception | None = None,
        usage_metadata: dict[str, int] | None = None,
    ) -> None:
        self.result = result
        self.payload = payload
        self.parsing_error = parsing_error
        self.usage_metadata = usage_metadata
        self.schema: type[BaseModel] | None = None

    def with_structured_output(
        self, schema: type[BaseModel], *, include_raw: bool = False
    ) -> FakeStructuredModel:
        self.schema = schema
        result = schema(**self.payload) if self.payload is not None else self.result
        return FakeStructuredModel(result, self.parsing_error, self.usage_metadata)


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


def test_planner_uses_structured_result_without_model_budgets(
    tmp_path: Path,
) -> None:
    fake_model = FakeModel(
        payload={
            "task_type": TaskType.DATA_ANALYSIS,
            "background": "The user has daily sales data in sales.csv.",
            "question": "Analyze the revenue trend.",
            "objective": "Analyze revenue trend",
            "output_type": OutputType.REPORT,
            "requirements": ["Mention trend"],
            "complexity": Complexity.MODERATE,
        }
    )
    planner = TaskBriefPlanner(model=fake_model)

    brief = planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert fake_model.schema is not None
    assert "budgets" not in fake_model.schema.model_json_schema()["properties"]
    assert "data_context" not in fake_model.schema.model_json_schema()["properties"]
    assert "analysis_hints" not in fake_model.schema.model_json_schema()["properties"]
    assert "warnings" not in fake_model.schema.model_json_schema()["properties"]
    assert brief == TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        background="The user has daily sales data in sales.csv.",
        question="Analyze the revenue trend.",
        objective="Analyze revenue trend",
        output_type=OutputType.REPORT,
        requirements=["Mention trend"],
        complexity=Complexity.MODERATE,
        budgets=budget_for_complexity(Complexity.MODERATE),
    )


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
    planner = TaskBriefPlanner(
        model=FakeModel(
            payload={
                "task_type": TaskType.DATA_ANALYSIS,
                "background": "The user has daily sales data in sales.csv.",
                "question": "Analyze the revenue trend.",
                "objective": "Analyze revenue trend",
                "output_type": OutputType.REPORT,
                "requirements": [],
                "complexity": Complexity.MODERATE,
                "budgets": {
                    "max_rounds": 1,
                    "max_code_cells": 1,
                    "max_debug_attempts": 0,
                    "timeout_seconds": 1,
                },
            }
        )
    )

    brief = planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.budgets == budget_for_complexity(Complexity.MODERATE)


def test_planner_records_structured_output_usage_metadata(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(
        model=FakeModel(
            payload={
                "task_type": TaskType.DATA_ANALYSIS,
                "background": "The user has daily sales data in sales.csv.",
                "question": "Analyze the revenue trend.",
                "objective": "Analyze revenue trend",
                "output_type": OutputType.REPORT,
                "requirements": [],
                "complexity": Complexity.MODERATE,
            },
            usage_metadata={
                "input_tokens": 11,
                "output_tokens": 7,
                "total_tokens": 18,
            },
        )
    )

    planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert planner.last_usage_metadata == {
        "input_tokens": 11,
        "output_tokens": 7,
        "total_tokens": 18,
    }
