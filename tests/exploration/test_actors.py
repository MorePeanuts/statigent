from pathlib import Path
from typing import Any, TypeVar, cast

from statigent.exploration import Coder, Debugger, Inspector, Reviewer
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

T = TypeVar("T")


def _make_raw_result(
    parsed: object = None, parsing_error: object = None
) -> dict[str, Any]:
    return {"raw": None, "parsed": parsed, "parsing_error": parsing_error}


class FakeStructuredModel[T]:
    def __init__(self, result: T, include_raw: bool = False) -> None:
        self.result = result
        self.include_raw = include_raw

    def invoke(self, _messages: list[dict[str, str]]) -> Any:
        if self.include_raw:
            return _make_raw_result(parsed=self.result)
        return self.result


class FakeModel:
    def __init__(self, result: object) -> None:
        self.result = result

    def with_structured_output(
        self, _schema: type[T], *, include_raw: bool = False
    ) -> FakeStructuredModel[Any]:
        return FakeStructuredModel(cast("T", self.result), include_raw=include_raw)


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


def test_inspector_returns_action(tmp_path: Path) -> None:
    action = ExplorationAction(
        kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
        title="Summarize revenue",
        description="Compute average revenue",
    )
    inspector = Inspector(FakeModel(action))

    result = inspector.next_action(make_brief(), make_profile(tmp_path), [], "")

    assert result == action


def test_reviewer_returns_decision() -> None:
    decision = ReviewDecision(approved=True, reason="Relevant")
    reviewer = Reviewer(FakeModel(decision))
    action = ExplorationAction(
        kind=ExplorationActionKind.INSPECT_SCHEMA,
        title="Inspect",
        description="Inspect schema",
    )

    result = reviewer.review_action(make_brief(), action)

    assert result.approved is True


def test_coder_returns_code_draft() -> None:
    draft = CodeDraft(
        code="print('ok')",
        purpose="Check data",
        expected_observation="ok",
    )
    coder = Coder(FakeModel(draft))
    action = ExplorationAction(
        kind=ExplorationActionKind.INSPECT_SCHEMA,
        title="Inspect",
        description="Inspect schema",
    )

    assert coder.write_code(make_brief(), action) == draft


def test_debugger_returns_debug_decision() -> None:
    decision = DebugDecision(retry=True, code="print('fixed')", reason="Name fixed")
    debugger = Debugger(FakeModel(decision))

    result = debugger.debug(make_brief(), "print(x)", "NameError")

    assert result.retry is True


def test_inspector_returns_final_draft(tmp_path: Path) -> None:
    draft = FinalDraft(content="Average revenue is 15.", evidence=["mean=15"])
    inspector = Inspector(FakeModel(draft))

    result = inspector.final_draft(make_brief(), make_profile(tmp_path), [])

    assert result.content == "Average revenue is 15."
