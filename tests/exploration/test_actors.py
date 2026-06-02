from pathlib import Path
from typing import Any, TypeVar, cast

import pytest
from langchain.messages import AIMessage

from statigent.errors import StatigentExplorationError
from statigent.exploration import Coder, Debugger, Inspector, Reviewer
from statigent.exploration.tools import make_replace_code_cell_tool
from statigent.notebook import FakeNotebookKernel, NotebookContext
from statigent.schemas import (
    Complexity,
    DatasetProfile,
    DebugDecision,
    DebugLesson,
    FinalDraft,
    FinalReviewDecision,
    InputFileInfo,
    NotebookCell,
    OutputType,
    ReviewerPlanDecision,
    TableProfile,
    TaskBrief,
    TaskType,
)

T = TypeVar("T")


def _make_raw_result(
    parsed: object = None, parsing_error: object = None
) -> dict[str, Any]:
    return {"raw": None, "parsed": parsed, "parsing_error": parsing_error}


class FakeStructuredModel[T]:
    def __init__(
        self,
        result: T,
        include_raw: bool = False,
        messages_seen: list[object] | None = None,
    ) -> None:
        self.result = result
        self.include_raw = include_raw
        self.messages_seen = messages_seen

    def invoke(self, messages: list[dict[str, str]]) -> Any:
        if self.messages_seen is not None:
            self.messages_seen[:] = list(messages)
        if self.include_raw:
            return _make_raw_result(parsed=self.result)
        return self.result


class FakeModel:
    def __init__(self, result: object) -> None:
        self.result = result
        self.messages_seen: list[object] = []

    def with_structured_output(
        self, _schema: type[T], *, include_raw: bool = False
    ) -> FakeStructuredModel[Any]:
        return FakeStructuredModel(
            cast("T", self.result),
            include_raw=include_raw,
            messages_seen=self.messages_seen,
        )

    def invoke(self, _messages: list[object]) -> object:
        return self.result


class FakeToolModel:
    def __init__(
        self,
        tool_name: str,
        args: dict[str, object],
        extra_tool_calls: list[dict[str, object]] | None = None,
        observation: str = "Observation generated from execution.",
    ) -> None:
        self.tool_name = tool_name
        self.args = args
        self.extra_tool_calls = extra_tool_calls or []
        self.observation = observation
        self.bound_tool_names: list[str] = []
        self.bind_call_count = 0
        self.messages_seen: list[object] = []
        self.invocations_seen: list[list[object]] = []
        self.tool_result_seen = ""

    def bind_tools(self, tools: list[object]) -> "FakeToolModel":
        self.bind_call_count += 1
        self.bound_tool_names = [getattr(tool, "name", "") for tool in tools]
        return self

    def invoke(self, _messages: list[object]) -> AIMessage:
        self.messages_seen = list(_messages)
        self.invocations_seen.append(list(_messages))
        if len(self.invocations_seen) > 1:
            return AIMessage(content=self.observation)
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


class FakeAgent:
    def __init__(self, model: FakeToolModel, tools: list[object]) -> None:
        self.model = model
        self.tools = tools

    def invoke(self, inputs: dict[str, object]) -> dict[str, list[AIMessage]]:
        messages = inputs.get("messages", [])
        if isinstance(messages, list):
            self.model.messages_seen = messages
            self.model.invocations_seen.append(list(messages))
        tool = self._tool_by_name(self.model.tool_name)
        if tool is not None:
            result = tool.invoke(self.model.args)
            self.model.tool_result_seen = str(result)
        for call in self.model.extra_tool_calls:
            extra_tool = self._tool_by_name(str(call["name"]))
            if extra_tool is not None:
                extra_tool.invoke(call["args"])
        return {"messages": [AIMessage(content=self.model.observation)]}

    def _tool_by_name(self, name: str) -> object | None:
        for tool in self.tools:
            if getattr(tool, "name", "") == name:
                return tool
        return None


def fake_agent_factory(
    model: object,
    tools: list[object],
    _system_prompt: str,
) -> FakeAgent:
    if not isinstance(model, FakeToolModel):
        raise TypeError("fake_agent_factory requires FakeToolModel")
    model.bind_call_count += 1
    model.bound_tool_names = [getattr(tool, "name", "") for tool in tools]
    return FakeAgent(model, tools)


def make_brief() -> TaskBrief:
    return TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        task_description=(
            "The user provided sales.csv with revenue data. Find average revenue."
        ),
        objective="Find average revenue",
        output_type=OutputType.ANSWER,
        complexity=Complexity.SIMPLE,
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
        coder_instruction="Compute mean revenue from the available data.",
    )
    model = FakeModel(decision)
    reviewer = Reviewer(model)

    result = reviewer.review_plan(
        make_brief(),
        make_profile(Path(".")),
        [],
        "Plan text",
    )

    assert result == decision
    prompt = str(model.messages_seen[-1].content)
    assert "Full execution path:" in prompt
    assert "Inspector plan:" in prompt


def test_reviewer_review_final_returns_final_decision() -> None:
    decision = FinalReviewDecision(approved=True, feedback="Complete")
    reviewer = Reviewer(FakeModel(decision))
    draft = FinalDraft(content="Average revenue is 15.", evidence=["mean=15"])

    result = reviewer.review_final(make_brief(), [], draft)

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
    coder = Coder(model, kernel, agent_factory=fake_agent_factory)
    instruction = "ACTION: inspect_schema\nQUESTION: What columns exist?"
    assert model.bound_tool_names == ["append_code_cell"]
    assert model.bind_call_count == 1

    cell = coder.append_code_cell(
        make_profile(tmp_path),
        instruction,
    )

    assert cell == kernel.get_code_context().cells[0]
    assert cell.code == "print('ok')"
    assert model.bound_tool_names == ["append_code_cell"]
    assert model.bind_call_count == 1
    assert len(model.invocations_seen) == 1
    coder_prompt = str(model.messages_seen[-1].content)
    assert "Available input paths:" in coder_prompt
    assert "Dataset profile:" in coder_prompt
    assert "Notebook code context:" in coder_prompt
    assert "Coder instruction:" in coder_prompt
    assert "Task brief:" not in coder_prompt
    assert "Use the listed input paths exactly" in coder_prompt


def test_coder_second_turn_uses_tool_and_execution_context(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    kernel.queue_result(stdout="mean=15\n")
    model = FakeToolModel(
        "append_code_cell",
        {
            "code": "print('mean=15')",
            "purpose": "Compute mean",
            "expected_observation": "mean",
        },
        observation="The requested mean is 15.",
    )
    coder = Coder(model, kernel, agent_factory=fake_agent_factory)

    outcome = coder.append_and_execute(
        make_profile(tmp_path),
        "Compute mean revenue.",
    )

    assert outcome.observation == "The requested mean is 15."
    assert len(model.invocations_seen) == 1
    assert "Execution result:" in model.tool_result_seen
    assert "mean=15" in model.tool_result_seen


def test_coder_binds_append_tool_once_at_initialization(tmp_path: Path) -> None:
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

    coder = Coder(model, kernel, agent_factory=fake_agent_factory)
    coder.append_code_cell(make_profile(tmp_path), "First approved instruction.")
    coder.append_code_cell(make_profile(tmp_path), "Second approved instruction.")

    assert model.bound_tool_names == ["append_code_cell"]
    assert model.bind_call_count == 1


def test_coder_append_code_cell_requires_agent_to_call_append_tool(
    tmp_path: Path,
) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    model = FakeToolModel(
        "unknown_tool",
        {
            "code": "print('first')",
            "purpose": "First",
            "expected_observation": "first",
        },
    )
    coder = Coder(model, kernel, agent_factory=fake_agent_factory)
    instruction = "ACTION: inspect_schema\nQUESTION: What columns exist?"

    with pytest.raises(StatigentExplorationError, match="did not call"):
        coder.append_code_cell(
            make_profile(tmp_path),
            instruction,
        )

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
    debugger = Debugger(model, agent_factory=fake_agent_factory)

    result = debugger.debug_cell(
        make_brief(),
        kernel,
        failed_cell=cell,
        error="NameError: missing",
        lessons=lessons,
    )

    assert result.lessons == lessons
    assert result.cell.cell_id == cell.cell_id
    assert result.result.cell_id == cell.cell_id
    assert result.result.ok
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


def test_debugger_returns_debug_decision() -> None:
    decision = DebugDecision(retry=True, code="print('fixed')", reason="Name fixed")
    debugger = Debugger(FakeModel(decision))

    result = debugger.debug(make_brief(), "print(x)", "NameError")

    assert result.retry is True


def test_inspector_returns_final_draft(tmp_path: Path) -> None:
    draft = FinalDraft(content="Average revenue is 15.", evidence=["mean=15"])
    model = FakeModel(draft)
    inspector = Inspector(model)

    result = inspector.final_draft(make_brief(), make_profile(tmp_path), [])

    assert result.content == "Average revenue is 15."
    system_prompt = str(model.messages_seen[0].content)
    assert "preserve the exact requested output format" in system_prompt.casefold()
    assert "@answer_name[value]" in system_prompt
