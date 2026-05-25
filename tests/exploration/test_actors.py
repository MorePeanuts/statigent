from pathlib import Path
from typing import Any, TypeVar, cast

import pytest
from langchain.messages import AIMessage

from statigent.errors import StatigentExplorationError
from statigent.exploration import Coder, Debugger, Inspector, Reviewer
from statigent.exploration.tools import make_replace_code_cell_tool
from statigent.notebook import FakeNotebookKernel, NotebookContext
from statigent.schemas import (
    ApprovedCodeInstruction,
    CodeDraft,
    Complexity,
    DatasetProfile,
    DebugDecision,
    DebugLesson,
    ExplorationAction,
    ExplorationActionKind,
    FinalDraft,
    FinalReviewDecision,
    InputFileInfo,
    NotebookCell,
    OutputType,
    ReviewDecision,
    ReviewerPlanDecision,
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

    def invoke(self, _messages: list[object]) -> object:
        return self.result


class FakeToolModel:
    def __init__(
        self,
        tool_name: str,
        args: dict[str, object],
        extra_tool_calls: list[dict[str, object]] | None = None,
    ) -> None:
        self.tool_name = tool_name
        self.args = args
        self.extra_tool_calls = extra_tool_calls or []
        self.bound_tool_names: list[str] = []

    def bind_tools(self, tools: list[object]) -> "FakeToolModel":
        self.bound_tool_names = [getattr(tool, "name", "") for tool in tools]
        return self

    def invoke(self, _messages: list[object]) -> AIMessage:
        tool_calls = [
            {
                "name": self.tool_name,
                "args": self.args,
                "id": "call-1",
            },
            *self.extra_tool_calls,
        ]
        return AIMessage(
            content="",
            tool_calls=tool_calls,
        )


def make_brief() -> TaskBrief:
    return TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        background="The user provided sales.csv with revenue data.",
        question="Find average revenue.",
        objective="Find average revenue",
        output_type=OutputType.ANSWER,
        requirements=[],
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


def test_replace_tool_is_bound_to_failed_cell_and_hides_cell_id(
    tmp_path: Path,
) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    cell = kernel.append_code_cell("print(missing)", "Fail", "error")

    tool = make_replace_code_cell_tool(kernel, cell.cell_id)
    replaced = tool.invoke(
        {
            "code": "print('fixed')",
            "purpose": "Fix",
            "expected_observation": "fixed",
        }
    )

    assert isinstance(replaced, NotebookCell)
    assert replaced.cell_id == cell.cell_id
    assert kernel.get_code_context().cells[0].code == "print('fixed')"
    assert "cell_id" not in tool.args_schema.model_json_schema()["properties"]


def test_inspector_next_plan_returns_text(tmp_path: Path) -> None:
    inspector = Inspector(FakeModel("Plan the next focused check."))

    result = inspector.next_plan(make_brief(), make_profile(tmp_path), [], "")

    assert result == "Plan the next focused check."


def test_reviewer_review_plan_returns_decision() -> None:
    decision = ReviewerPlanDecision(
        approved=True,
        reason="Relevant",
        action_kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
        question="What is average revenue?",
        evidence_needed="Mean revenue",
        coding_instruction="Compute the mean revenue.",
    )
    reviewer = Reviewer(FakeModel(decision))

    result = reviewer.review_plan(make_brief(), "Plan text")

    assert result == decision


def test_reviewer_review_final_returns_final_decision() -> None:
    decision = FinalReviewDecision(approved=True, reason="Complete")
    reviewer = Reviewer(FakeModel(decision))
    draft = FinalDraft(content="Average revenue is 15.", evidence=["mean=15"])

    result = reviewer.review_final(make_brief(), draft)

    assert result == decision


def test_coder_append_code_cell_uses_append_tool(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    model = FakeToolModel(
        "append_code_cell",
        {
            "code": "print('ok')",
            "purpose": "Check data",
            "expected_observation": "ok",
        },
    )
    coder = Coder(model)
    instruction = ApprovedCodeInstruction(
        action_kind=ExplorationActionKind.INSPECT_SCHEMA,
        question="What columns exist?",
        evidence_needed="Column list",
        coding_instruction="Print columns.",
        action_prompt="Inspect schema.",
    )

    cell = coder.append_code_cell(make_brief(), instruction, kernel)

    assert cell == kernel.get_code_context().cells[0]
    assert cell.code == "print('ok')"
    assert model.bound_tool_names == ["append_code_cell"]


def test_coder_append_code_cell_rejects_duplicate_tool_calls(
    tmp_path: Path,
) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    model = FakeToolModel(
        "append_code_cell",
        {
            "code": "print('first')",
            "purpose": "First",
            "expected_observation": "first",
        },
        extra_tool_calls=[
            {
                "name": "append_code_cell",
                "args": {
                    "code": "print('second')",
                    "purpose": "Second",
                    "expected_observation": "second",
                },
                "id": "call-2",
            }
        ],
    )
    coder = Coder(model)
    instruction = ApprovedCodeInstruction(
        action_kind=ExplorationActionKind.INSPECT_SCHEMA,
        question="What columns exist?",
        evidence_needed="Column list",
        coding_instruction="Print columns.",
        action_prompt="Inspect schema.",
    )

    with pytest.raises(StatigentExplorationError, match="exactly one"):
        coder.append_code_cell(make_brief(), instruction, kernel)

    assert kernel.get_code_context().cells == []


def test_debugger_debug_cell_uses_replace_and_records_lesson(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    cell = kernel.append_code_cell("print(missing)", "Fail", "error")
    lessons: list[DebugLesson] = []
    model = FakeToolModel(
        "replace_code_cell",
        {
            "code": "print('fixed')",
            "purpose": "Fix missing variable",
            "expected_observation": "fixed",
        },
        extra_tool_calls=[
            {
                "name": "record_debug_lesson",
                "args": {
                    "error_pattern": "NameError",
                    "root_cause": "Missing variable was referenced",
                    "fix_strategy": "Define the value before using it",
                    "applies_when": "A cell references an undefined name",
                },
                "id": "call-2",
            }
        ],
    )
    debugger = Debugger(model)

    result = debugger.debug_cell(
        make_brief(),
        kernel,
        failed_cell=cell,
        error="NameError: missing",
        lessons=lessons,
    )

    assert result == lessons
    assert kernel.get_code_context().cells[0].code == "print('fixed')"
    assert model.bound_tool_names == ["replace_code_cell", "record_debug_lesson"]
    assert lessons == [
        DebugLesson(
            error_pattern="NameError",
            root_cause="Missing variable was referenced",
            fix_strategy="Define the value before using it",
            applies_when="A cell references an undefined name",
        )
    ]


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
