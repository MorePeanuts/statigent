"""LLM-backed exploration actors for the Inspector-Reviewer-Coder-Debugger loop.

The actors keep LangChain dependencies at the boundary: Inspector uses plain
chat invocation for planning, Reviewer uses structured output, and
Coder/Debugger make notebook changes only through bound tools.
"""

from typing import Any, Protocol, TypeVar, cast

from langchain.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool

from statigent.errors import StatigentExplorationError
from statigent.exploration.prompts import (
    CODER_SYSTEM_PROMPT,
    DEBUGGER_SYSTEM_PROMPT,
    FINAL_REVIEWER_SYSTEM_PROMPT,
    INSPECTOR_PLAN_SYSTEM_PROMPT,
    REVIEWER_PLAN_SYSTEM_PROMPT,
)
from statigent.exploration.tools import (
    make_append_code_cell_tool,
    make_record_debug_lesson_tool,
    make_replace_code_cell_tool,
)
from statigent.notebook.base import NotebookKernel
from statigent.retry import invoke_structured_with_retries, retry_on_parse_error
from statigent.schemas import (
    ApprovedCodeInstruction,
    CodeDraft,
    DatasetProfile,
    DebugDecision,
    DebugLesson,
    ExplorationAction,
    ExplorationStep,
    FinalDraft,
    FinalReviewDecision,
    NotebookCell,
    ReviewDecision,
    ReviewerPlanDecision,
    TaskBrief,
)

T = TypeVar("T")
T_co = TypeVar("T_co", covariant=True)


class _StructuredRunnable(Protocol[T_co]):
    def invoke(self, messages: list[AnyMessage]) -> T_co: ...


class _StructuredModel(Protocol):
    def with_structured_output(
        self, schema: type[T], *, include_raw: bool = False
    ) -> _StructuredRunnable[Any]: ...


class _ChatModel(_StructuredModel, Protocol):
    def invoke(self, messages: list[AnyMessage]) -> object: ...


class _ToolRunnable(Protocol):
    def invoke(self, messages: list[AnyMessage]) -> object: ...


class _ToolModel(Protocol):
    def bind_tools(self, tools: list[StructuredTool]) -> _ToolRunnable: ...


def _invoke_with_retries[T](
    model: _StructuredModel,
    schema: type[T],
    messages: list[AnyMessage],
) -> T:
    structured = model.with_structured_output(schema, include_raw=True)
    result = retry_on_parse_error(invoke_structured_with_retries)(structured, messages)
    return cast("T", result)


def _message_text(result: object) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, AIMessage):
        if isinstance(result.content, str):
            return result.content
        return str(result.content)
    content = getattr(result, "content", None)
    if isinstance(content, str):
        return content
    return str(result)


def _invoke_tool_call(
    model: _ToolModel,
    tools: list[StructuredTool],
    messages: list[AnyMessage],
    expected_tool_name: str,
) -> object:
    response = model.bind_tools(tools).invoke(messages)
    if not isinstance(response, AIMessage):
        raise StatigentExplorationError(
            f"Tool model returned {type(response).__name__}, expected AIMessage"
        )
    tool_by_name = {tool.name: tool for tool in tools}
    expected_result: object | None = None
    for call in response.tool_calls:
        name = call["name"]
        tool = tool_by_name.get(name)
        if tool is None:
            raise StatigentExplorationError(f"Unknown tool call: {name}")
        result = tool.invoke(call["args"])
        if name == expected_tool_name:
            expected_result = result
    if expected_result is None:
        raise StatigentExplorationError(f"Model did not call {expected_tool_name}")
    return expected_result


class Inspector:
    """Proposes the next exploration action and drafts the final output."""

    def __init__(self, model: object) -> None:
        self.model = cast("_ChatModel", model)

    def next_plan(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
        reviewer_feedback: str,
    ) -> str:
        """Return an unstructured text plan for the next exploration step."""
        result = self.model.invoke(
            [
                SystemMessage(content=INSPECTOR_PLAN_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Profile:\n{profile.compact_summary()}\n\n"
                        f"Completed steps:\n{[s.model_dump() for s in steps]}\n\n"
                        f"Reviewer feedback:\n{reviewer_feedback}"
                    ),
                ),
            ]
        )
        return _message_text(result)

    def next_action(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
        reviewer_feedback: str,
    ) -> ExplorationAction:
        # TODO: context engineering for Inspector
        return _invoke_with_retries(
            self.model,
            # BUG: next_action is completely unsuitable for structured output.
            # Here should be a carefully designed prompt that guides the model to
            # complete data exploration instructions.
            ExplorationAction,
            [
                SystemMessage(
                    content=(
                        "You are the Inspector. Choose the next useful data "
                        "exploration action. Prefer predefined DEA actions."
                    ),
                ),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Profile:\n{profile.compact_summary()}\n\n"
                        f"Completed steps: {len(steps)}\n"
                        # TODO: include step results (stdout/artifacts) in
                        # context so Inspector can reason over prior findings.
                        f"Reviewer feedback:\n{reviewer_feedback}"
                    ),
                ),
            ],
        )

    def final_draft(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
    ) -> FinalDraft:
        # TODO: Output different types based on the task type. If it is only a data
        # analysis task (question-based), output the answer directly. If it is a data
        # modeling task, output a structured data insight report.
        return _invoke_with_retries(
            self.model,
            FinalDraft,
            [
                SystemMessage(
                    content=(
                        "You are the Inspector. Draft the final answer or report."
                    ),
                ),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Profile:\n{profile.compact_summary()}\n\n"
                        # TODO: trim large step outputs before sending to LLM;
                        # full model_dump() may exceed context window limits.
                        f"Exploration steps:\n{[s.model_dump() for s in steps]}"
                    ),
                ),
            ],
        )


class Reviewer:
    """Reviews proposed actions for relevance and safety, and evaluates final drafts."""

    def __init__(self, model: object) -> None:
        self.model = cast("_StructuredModel", model)

    def review_plan(
        self,
        brief: TaskBrief,
        plan_text: str,
    ) -> ReviewerPlanDecision:
        """Review an Inspector text plan as structured output."""
        return _invoke_with_retries(
            self.model,
            ReviewerPlanDecision,
            [
                SystemMessage(content=REVIEWER_PLAN_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Inspector plan:\n{plan_text}"
                    ),
                ),
            ],
        )

    def review_action(
        self,
        brief: TaskBrief,
        action: ExplorationAction,
    ) -> ReviewDecision:
        # TODO: Analyze the inspector's thought process, determine whether it is
        # correct, and extract the specific action.
        return _invoke_with_retries(
            self.model,
            ReviewDecision,
            [
                SystemMessage(
                    content=(
                        "You are the Reviewer. Approve only relevant, necessary, "
                        "safe exploration actions. Apply strict scrutiny to "
                        "custom_analysis."
                    ),
                ),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Action:\n{action.model_dump_json()}"
                    ),
                ),
            ],
        )

    def review_final(
        self,
        brief: TaskBrief,
        draft: FinalDraft,
    ) -> FinalReviewDecision:
        # TODO: The final review should be used to determine whether the insector's
        # final output has completed the tasks for this stage. If not, and if the budget
        # limit has not been reached, more exploration steps are needed.
        return _invoke_with_retries(
            self.model,
            FinalReviewDecision,
            [
                SystemMessage(content=FINAL_REVIEWER_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Draft:\n{draft.model_dump_json()}"
                    ),
                ),
            ],
        )


class Coder:
    """Writes incremental Python notebook cells for approved exploration actions."""

    def __init__(self, model: object) -> None:
        self.model = cast("_StructuredModel", model)
        self._tool_model = cast("_ToolModel", model)

    def append_code_cell(
        self,
        brief: TaskBrief,
        instruction: ApprovedCodeInstruction,
        kernel: NotebookKernel,
    ) -> NotebookCell:
        """Append an approved code cell through the notebook append tool."""
        tool = make_append_code_cell_tool(kernel)
        result = _invoke_tool_call(
            self._tool_model,
            [tool],
            [
                SystemMessage(content=CODER_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Approved instruction:\n{instruction.model_dump_json()}"
                    ),
                ),
            ],
            "append_code_cell",
        )
        if not isinstance(result, NotebookCell):
            raise StatigentExplorationError(
                f"append_code_cell returned {type(result).__name__}, "
                "expected NotebookCell"
            )
        return result

    def write_code(self, brief: TaskBrief, action: ExplorationAction) -> CodeDraft:
        # BUG: The coder should bind a `append_code_cell` tool to add cells to the code
        # context, but not execute them for now. Additionally, each cell corresponds
        # to a question passed from the reviewer.
        return _invoke_with_retries(
            self.model,
            CodeDraft,
            [
                SystemMessage(
                    content=(
                        "You are the Coder. Write one incremental Python notebook "
                        "cell for the approved data analysis action."
                    ),
                ),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Action:\n{action.model_dump_json()}"
                    ),
                ),
            ],
        )


# TODO: The debugger should be equipped with a replace_code_cell tool, using a React
# agent focused on solving code debugging issues.
class Debugger:
    """Diagnoses failed cells and proposes corrected code, or recommends abandonment."""

    def __init__(self, model: object) -> None:
        self.model = cast("_StructuredModel", model)
        self._tool_model = cast("_ToolModel", model)

    def debug_cell(
        self,
        brief: TaskBrief,
        kernel: NotebookKernel,
        failed_cell: NotebookCell,
        error: str,
        lessons: list[DebugLesson],
    ) -> list[DebugLesson]:
        """Repair a failed notebook cell through a replace tool bound to its id."""
        replace_tool = make_replace_code_cell_tool(kernel, failed_cell.cell_id)
        lesson_tool = make_record_debug_lesson_tool(lessons)
        _invoke_tool_call(
            self._tool_model,
            [replace_tool, lesson_tool],
            [
                SystemMessage(content=DEBUGGER_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Failed cell:\n{failed_cell.model_dump_json()}\n\n"
                        f"Error:\n{error}\n\n"
                        "Existing lessons:\n"
                        f"{[lesson.model_dump() for lesson in lessons]}"
                    ),
                ),
            ],
            "replace_code_cell",
        )
        return lessons

    def debug(self, brief: TaskBrief, code: str, error: str) -> DebugDecision:
        return _invoke_with_retries(
            self.model,
            DebugDecision,
            [
                SystemMessage(
                    content=(
                        "You are the Debugger. Return corrected code if retrying "
                        "is useful; otherwise explain why to abandon this action."
                    ),
                ),
                HumanMessage(
                    content=(
                        f"Task brief:\n{brief.model_dump_json()}\n\n"
                        f"Failed code:\n{code}\n\nError:\n{error}"
                    ),
                ),
            ],
        )
