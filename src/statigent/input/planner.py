"""Task brief generation from user prompts and dataset profiles.

Uses LangChain structured output to classify the task and estimate
complexity. When the LLM fails (malformed JSON, validation errors,
or upstream API issues), a deterministic keyword-based fallback
produces a safe default TaskBrief so the pipeline never blocks.
"""

from typing import Protocol, cast

from langchain.messages import AnyMessage, HumanMessage, SystemMessage
from langchain_core.exceptions import LangChainException, OutputParserException
from loguru import logger
from pydantic import ValidationError

from statigent.schemas import (
    Complexity,
    DatasetProfile,
    OutputType,
    TaskBrief,
    TaskType,
    budget_for_complexity,
)


class _StructuredTaskBriefModel(Protocol):
    def invoke(self, messages: list[AnyMessage]) -> TaskBrief: ...


class _TaskBriefModel(Protocol):
    def with_structured_output(
        self,
        schema: type[TaskBrief],
    ) -> _StructuredTaskBriefModel: ...


# Only catch structured-output-specific failures here — genuine programming
# errors (TypeError, MemoryError, etc.) must propagate to fail fast.
_EXPECTED_STRUCTURED_OUTPUT_ERRORS = (
    ValidationError,
    OutputParserException,
    LangChainException,
)


class TaskBriefPlanner:
    """Generate a TaskBrief from a user prompt, instructions, and dataset profile.

    Uses LLM structured output with a deterministic fallback so the
    pipeline degrades gracefully when the model produces unparseable output.
    """

    def __init__(self, model: object) -> None:
        self.model = cast("_TaskBriefModel", model)

    def create_brief(
        self,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief:
        """Create a TaskBrief using the LLM, falling back on keyword heuristics."""
        messages = self._build_messages(
            prompt=prompt,
            task_instructions=task_instructions,
            profile=profile,
        )
        try:
            structured_model = self.model.with_structured_output(TaskBrief)
            return structured_model.invoke(messages)
        except _EXPECTED_STRUCTURED_OUTPUT_ERRORS as err:
            logger.warning("Task brief structured output failed: {}", err)
            return self._fallback_brief(
                prompt=prompt,
                task_instructions=task_instructions,
                profile=profile,
                error=err,
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
                    "Create a concise structured data science task brief. "
                    "Use the provided task request, extra instructions, and "
                    "dataset summary. Return only fields in the TaskBrief schema."
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

    def _fallback_brief(
        self,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
        error: Exception,
    ) -> TaskBrief:
        task_type, output_type, complexity = self._fallback_classification(prompt)
        return TaskBrief(
            task_type=task_type,
            objective=prompt.strip() or "Analyze the provided dataset.",
            output_type=output_type,
            requirements=self._fallback_requirements(task_instructions),
            data_context=profile.compact_summary(),
            complexity=complexity,
            budgets=budget_for_complexity(complexity),
            warnings=[
                "LLM parsing failure; using deterministic fallback task brief. "
                f"Error: {error}"
            ],
        )

    def _fallback_classification(
        self,
        prompt: str,
    ) -> tuple[TaskType, OutputType, Complexity]:
        normalized = prompt.casefold()
        if self._contains_any(
            normalized,
            ("predict", "prediction", "predictive", "modeling", "model", "forecast"),
        ):
            return (
                TaskType.DATA_MODELING,
                OutputType.FILE,
                Complexity.COMPLEX,
            )
        if self._contains_any(
            normalized,
            ("deep", "business", "commercial", "executive"),
        ):
            return (
                TaskType.DEEP_ANALYSIS,
                OutputType.REPORT,
                Complexity.COMPLEX,
            )
        if self._contains_any(normalized, ("report", "analysis", "analyze", "analyse")):
            return (
                TaskType.DATA_ANALYSIS,
                OutputType.REPORT,
                Complexity.MODERATE,
            )
        return (
            TaskType.DATA_ANALYSIS,
            OutputType.ANSWER,
            Complexity.SIMPLE,
        )

    def _fallback_requirements(self, task_instructions: str) -> list[str]:
        instructions = task_instructions.strip()
        if not instructions:
            return []
        return [instructions]

    def _contains_any(self, value: str, terms: tuple[str, ...]) -> bool:
        return any(term in value for term in terms)
