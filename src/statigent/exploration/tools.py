"""LangChain tool wrappers for notebook cell lifecycle operations."""

from langchain_core.tools import StructuredTool

from statigent.notebook.base import NotebookKernel
from statigent.schemas import DebugLesson, NotebookCell


def make_append_code_cell_tool(kernel: NotebookKernel) -> StructuredTool:
    """Create a tool that appends one notebook code cell."""

    def append_code_cell(
        code: str,
        purpose: str,
        expected_observation: str,
    ) -> NotebookCell:
        """Append a Python code cell to the notebook."""
        return kernel.append_code_cell(code, purpose, expected_observation)

    return StructuredTool.from_function(append_code_cell)


def make_replace_code_cell_tool(
    kernel: NotebookKernel,
    cell_id: str,
) -> StructuredTool:
    """Create a tool that replaces one preselected notebook code cell."""

    def replace_code_cell(
        code: str,
        purpose: str,
        expected_observation: str,
    ) -> NotebookCell:
        """Replace the failed Python code cell with corrected code."""
        return kernel.replace_code_cell(cell_id, code, purpose, expected_observation)

    return StructuredTool.from_function(replace_code_cell)


def make_record_debug_lesson_tool(lessons: list[DebugLesson]) -> StructuredTool:
    """Create a tool that records task-local debugging lessons."""

    def record_debug_lesson(
        error_pattern: str,
        root_cause: str,
        fix_strategy: str,
        applies_when: str,
    ) -> DebugLesson:
        """Record a reusable debugging lesson for this exploration task."""
        lesson = DebugLesson(
            error_pattern=error_pattern,
            root_cause=root_cause,
            fix_strategy=fix_strategy,
            applies_when=applies_when,
        )
        lessons.append(lesson)
        return lesson

    return StructuredTool.from_function(record_debug_lesson)


__all__ = [
    "make_append_code_cell_tool",
    "make_record_debug_lesson_tool",
    "make_replace_code_cell_tool",
]
