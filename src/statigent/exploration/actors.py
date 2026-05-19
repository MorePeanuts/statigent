"""LLM-backed exploration actors for the Inspector-Reviewer-Coder-Debugger loop.

Each actor wraps a LangChain chat model with structured output. The actor
Protocols used here avoid coupling to LangChain's BaseChatModel — any
callable that satisfies `with_structured_output(Schema) -> Runnable`
works, which keeps tests simple (plain fake objects, no mocking framework).
"""

from typing import Any, Protocol, TypeVar, cast

from langchain.messages import AnyMessage, HumanMessage, SystemMessage

from statigent.retry import invoke_structured_with_retries, retry_on_parse_error
from statigent.schemas import (
    CodeDraft,
    DatasetProfile,
    DebugDecision,
    ExplorationAction,
    ExplorationStep,
    FinalDraft,
    ReviewDecision,
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


def _invoke_with_retries[T](
    model: _StructuredModel,
    schema: type[T],
    messages: list[AnyMessage],
) -> T:
    structured = model.with_structured_output(schema, include_raw=True)
    result = retry_on_parse_error(invoke_structured_with_retries)(structured, messages)
    return cast("T", result)


class Inspector:
    """Proposes the next exploration action and drafts the final output."""

    def __init__(self, model: object) -> None:
        self.model = cast("_StructuredModel", model)

    def next_action(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
        reviewer_feedback: str,
    ) -> ExplorationAction:
        return _invoke_with_retries(
            self.model,
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

    def review_action(
        self,
        brief: TaskBrief,
        action: ExplorationAction,
    ) -> ReviewDecision:
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

    def review_final(self, brief: TaskBrief, draft: FinalDraft) -> ReviewDecision:
        return _invoke_with_retries(
            self.model,
            ReviewDecision,
            [
                SystemMessage(
                    content=(
                        "You are the final Reviewer. Approve only if the draft "
                        "answers the task, cites evidence, and follows output "
                        "constraints."
                    ),
                ),
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

    def write_code(self, brief: TaskBrief, action: ExplorationAction) -> CodeDraft:
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


class Debugger:
    """Diagnoses failed cells and proposes corrected code, or recommends abandonment."""

    def __init__(self, model: object) -> None:
        self.model = cast("_StructuredModel", model)

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
