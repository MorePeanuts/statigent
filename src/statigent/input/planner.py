"""Task brief generation from user prompts and dataset profiles.

Uses LangChain structured output to classify the task, estimate complexity,
and capture user-facing requirements. Resource budgets are always derived by
the system from the selected complexity tier.
"""

from langchain.messages import AnyMessage, HumanMessage, SystemMessage
from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from statigent.errors import StatigentParseError
from statigent.retry import invoke_structured_with_usage, retry_on_parse_error
from statigent.schemas import (
    Complexity,
    DatasetProfile,
    OutputType,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


class _TaskBriefPlan(BaseModel):
    task_type: TaskType = Field(description="Category of task requested by the user")
    background: str = Field(
        description=(
            "Complete background context from the user's request, preserving all "
            "material facts and references"
        )
    )
    question: str = Field(
        description="Complete description of the user's question without summarization"
    )
    objective: str = Field(
        description="Concise task objective distilled from the request"
    )
    output_type: OutputType = Field(
        description="Shape of deliverable requested by the user"
    )
    requirements: list[str] = Field(
        default_factory=list, description="Explicit requirements from user instructions"
    )
    complexity: Complexity = Field(
        description="Expected effort tier for completing the task"
    )

    def to_task_brief(self) -> TaskBrief:
        """Convert model-selected planning fields into a system-budgeted brief."""
        return TaskBrief(
            task_type=self.task_type,
            background=self.background,
            question=self.question,
            objective=self.objective,
            output_type=self.output_type,
            requirements=self.requirements,
            complexity=self.complexity,
            budgets=budget_for_complexity(self.complexity),
        )


class TaskBriefPlanner:
    """Generate a TaskBrief from a user prompt, instructions, and dataset profile.

    Uses LLM structured output for semantic classification. Budgets are
    system-owned and derived after parsing.
    """

    def __init__(self, model: BaseChatModel) -> None:
        self.model = model
        self.last_usage_metadata: dict[str, int] = {}

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
            _TaskBriefPlan, include_raw=True
        )
        result, self.last_usage_metadata = retry_on_parse_error(
            invoke_structured_with_usage
        )(
            structured_model, messages
        )
        if not isinstance(result, _TaskBriefPlan):
            raise StatigentParseError(
                "Task brief structured output returned "
                f"{type(result).__name__}, expected _TaskBriefPlan"
            )
        return result.to_task_brief()

    def _build_messages(
        self,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> list[AnyMessage]:
        return [
            SystemMessage(
                content=(
                    "Create a structured data science task brief from "
                    "the user's request, extra instructions, and dataset summary. "
                    "Preserve the original task information: background should "
                    "fully describe the problem context, question should fully "
                    "state the user question, objective should be a concise task "
                    "goal, and requirements should list explicit constraints. "
                    "Do not propose solution approaches, analysis hints, warnings, "
                    "or implementation steps. Numeric budgets are system-derived "
                    "from the complexity tier; do not invent or tune budget values. "
                    "Return only fields in the provided structured output schema."
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
