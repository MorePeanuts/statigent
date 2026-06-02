"""Task brief generation from user prompts and dataset profiles.

Uses LangChain structured output to classify the task and estimate complexity.
Resource budgets are always derived by the system from the selected complexity
tier.
"""

from typing import TypeVar

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
)


class _TaskBriefDecision(BaseModel):
    task_type: TaskType = Field(description="Category of task requested by the user")
    objective: str = Field(
        description="Concise task objective distilled from the request"
    )
    restrictions: list[str] = Field(
        default_factory=list,
        description=(
            "Task-specific hard restrictions copied or distilled from the user "
            "request, requirements, and requested output format. Include only "
            "constraints for this task, not general agent policies."
        ),
    )
    output_type: OutputType = Field(
        description="Shape of deliverable requested by the user"
    )
    complexity: Complexity = Field(
        description="Expected effort tier for completing the task"
    )

    def to_task_brief(self, task_description: str) -> TaskBrief:
        """Convert model-selected planning fields into a system-budgeted brief."""
        return TaskBrief(
            task_type=self.task_type,
            task_description=task_description,
            objective=self.objective,
            restrictions=self.restrictions,
            output_type=self.output_type,
            complexity=self.complexity,
        )


class _TaskBriefPlan(_TaskBriefDecision):
    task_description: str = Field(
        description=(
            "Complete description of the user's task, preserving material context, "
            "questions, constraints, and requested details"
        )
    )

    def to_task_brief(self, task_description: str | None = None) -> TaskBrief:
        """Convert model-selected planning fields into a system-budgeted brief."""
        return super().to_task_brief(self.task_description)


class _BenchmarkTaskBriefPlan(_TaskBriefDecision):
    pass


_PlanT = TypeVar("_PlanT", bound=_TaskBriefDecision)


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
        *,
        generate_task_description: bool = True,
    ) -> TaskBrief:
        """Create a TaskBrief using the LLM structured output contract."""
        if not generate_task_description:
            return self.create_benchmark_brief(
                prompt=prompt,
                task_instructions=task_instructions,
                profile=profile,
            )

        messages = self._build_descriptive_messages(
            prompt=prompt,
            task_instructions=task_instructions,
            profile=profile,
        )
        result = self._invoke_plan(_TaskBriefPlan, messages)
        return result.to_task_brief()

    def create_benchmark_brief(
        self,
        *,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief:
        """Create a TaskBrief that preserves benchmark input verbatim."""
        messages = self._build_benchmark_messages(
            prompt=prompt,
            task_instructions=task_instructions,
            profile=profile,
        )
        result = self._invoke_plan(_BenchmarkTaskBriefPlan, messages)
        return result.to_task_brief(
            self._raw_task_description(
                prompt=prompt,
                task_instructions=task_instructions,
            )
        )

    def _invoke_plan(
        self,
        schema: type[_PlanT],
        messages: list[AnyMessage],
    ) -> _PlanT:
        structured_model = self.model.with_structured_output(schema, include_raw=True)
        result, self.last_usage_metadata = retry_on_parse_error(
            invoke_structured_with_usage
        )(structured_model, messages)
        if not isinstance(result, schema):
            raise StatigentParseError(
                "Task brief structured output returned "
                f"{type(result).__name__}, expected {schema.__name__}"
            )
        return result

    def _build_descriptive_messages(
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
                    "Generate task_description by preserving the original task "
                    "information, including material context, questions, "
                    "constraints, and requested details. The objective should be "
                    "a concise task goal. Extract task-specific restrictions "
                    "from the request, requirements, and output format. "
                    "Restrictions must only contain constraints for this task, "
                    "not general agent policies. "
                    "Do not propose solution approaches, analysis hints, warnings, "
                    "or implementation steps. Numeric budgets are system-derived "
                    "from the complexity tier; do not invent or tune budget values. "
                    "Return only fields in the provided structured output schema."
                ),
            ),
            self._human_message(prompt, task_instructions, profile),
        ]

    def _build_benchmark_messages(
        self,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> list[AnyMessage]:
        return [
            SystemMessage(
                content=(
                    "Create a structured data science task brief for a benchmark "
                    "request. Classify the task, objective, output type, and "
                    "complexity from the user request, extra instructions, and "
                    "dataset summary. In benchmarks, machine learning tasks that "
                    "specify a fixed random seed, fixed split, fixed model, or "
                    "fixed metric to obtain a deterministic answer should be "
                    "classified as data_analysis unless they require generating "
                    "a competition submission or optimizing model quality. Extract "
                    "task-specific restrictions from the request, requirements, "
                    "and output format. Restrictions must only contain constraints "
                    "for this task, not general agent policies. Do not include "
                    "task_description in the "
                    "structured output; the system will copy the benchmark input "
                    "into that field exactly. Do not propose solution approaches, "
                    "analysis hints, warnings, or implementation steps. Numeric "
                    "budgets are system-derived from the complexity tier; do not "
                    "invent or tune budget values. Return only fields in the "
                    "provided structured output schema."
                ),
            ),
            self._human_message(prompt, task_instructions, profile),
        ]

    def _human_message(
        self,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> HumanMessage:
        return HumanMessage(
            content="\n\n".join(
                [
                    f"Prompt:\n{prompt}",
                    f"Task instructions:\n{task_instructions or 'None'}",
                    f"Dataset profile:\n{profile.compact_summary()}",
                ]
            ),
        )

    def _raw_task_description(self, prompt: str, task_instructions: str) -> str:
        parts = [part for part in (prompt, task_instructions) if part]
        return "\n\n".join(parts)
