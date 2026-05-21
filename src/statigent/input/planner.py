"""Task brief generation from user prompts and dataset profiles.

Uses LangChain structured output to classify the task, estimate complexity,
and capture user-facing requirements. Resource budgets are always derived by
the system from the selected complexity tier.
"""

from langchain.messages import AnyMessage, HumanMessage, SystemMessage
from langchain_core.language_models.chat_models import BaseChatModel

from statigent.errors import StatigentParseError
from statigent.retry import invoke_structured_with_retries, retry_on_parse_error
from statigent.schemas import (
    DatasetProfile,
    TaskBrief,
    budget_for_complexity,
)


class TaskBriefPlanner:
    """Generate a TaskBrief from a user prompt, instructions, and dataset profile.

    Uses LLM structured output for semantic classification. Budgets are
    system-owned and derived after parsing.
    """

    def __init__(self, model: BaseChatModel) -> None:
        self.model = model

    def create_brief(
        self,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief:
        """Create a TaskBrief using the LLM structured output contract."""
        messages = self._build_messages(
            prompt=prompt,
            task_instructions=task_instructions,
            profile=profile,
        )
        structured_model = self.model.with_structured_output(
            TaskBrief, include_raw=True
        )
        result = retry_on_parse_error(invoke_structured_with_retries)(
            structured_model, messages
        )
        if not isinstance(result, TaskBrief):
            raise StatigentParseError(
                "Task brief structured output returned "
                f"{type(result).__name__}, expected TaskBrief"
            )
        return result.model_copy(
            update={"budgets": budget_for_complexity(result.complexity)}
        )

    def _build_messages(
        self,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> list[AnyMessage]:
        return [
            SystemMessage(
                content=(
                    "Create a concise structured data science task brief from "
                    "the user's request, extra instructions, and dataset summary. "
                    "Classify the task type, objective, output type, explicit "
                    "requirements, data context, useful analysis hints, and "
                    "complexity tier. Numeric budgets are system-derived from "
                    "the complexity tier; do not invent or tune budget values. "
                    "Return only fields in the TaskBrief schema."
                ),
            ),
            HumanMessage(
                content="\n\n".join(
                    [
                        f"Prompt:\n{prompt}",
                        f"Task instructions:\n{task_instructions or 'None'}",
                        f"Dataset profile:\n{profile.compact_summary()}",
                    ]
                ),
            ),
        ]
