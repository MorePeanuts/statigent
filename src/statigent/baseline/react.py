"""React baseline agent with built-in tools."""

import re
from pathlib import Path
from typing import Any

from langchain.agents import create_agent
from langchain.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
from langchain.tools import tool
from langchain_experimental.utilities import PythonREPL
from loguru import logger

from statigent.benchmarks.base import AgentTrace
from statigent.models import get_model

_python_repl = PythonREPL()

_DANGEROUS_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bos\.system\b"),
    re.compile(r"\bsubprocess\b"),
    re.compile(r"\bshutil\.rmtree\b"),
    re.compile(r"\bos\.remove\b"),
    re.compile(r"\bos\.unlink\b"),
    re.compile(r"\brm\s+-rf\b"),
    re.compile(r'\bopen\s*\([^)]*["\']w'),
    re.compile(r"\b__import__\b"),
    re.compile(r"\beval\b"),
    re.compile(r"\bexec\b"),
    re.compile(r"\bcompile\b"),
]


def _check_code_safety(code: str) -> str | None:
    """Return a warning message if code contains dangerous patterns, else None."""
    for pattern in _DANGEROUS_PATTERNS:
        match = pattern.search(code)
        if match:
            return f"Blocked: dangerous pattern '{match.group()}' detected in code."
    return None


def _serialize_messages(messages: list[AnyMessage]) -> AgentTrace:
    """Convert langchain message objects to JSON-serializable dicts."""
    trace: AgentTrace = []
    for msg in messages:
        entry: dict[str, Any] = {"role": msg.type}
        if isinstance(msg, HumanMessage):
            entry["role"] = "user"
            entry["content"] = msg.content
        elif isinstance(msg, AIMessage):
            entry["role"] = "assistant"
            entry["content"] = msg.content
            if msg.tool_calls:
                entry["tool_calls"] = [
                    {"name": tc["name"], "args": tc["args"], "id": tc.get("id", "")}
                    for tc in msg.tool_calls
                ]
        elif isinstance(msg, ToolMessage):
            entry["role"] = "tool"
            entry["name"] = msg.name or ""
            entry["content"] = msg.content
            entry["tool_call_id"] = msg.tool_call_id
        else:
            entry["content"] = msg.content
        trace.append(entry)
    return trace


@tool
def python_repl(code: str) -> str:
    """Execute Python code and return the output.

    Use this to run data analysis code. Available packages: pandas, numpy,
    scikit-learn, torch, scipy, matplotlib, seaborn.
    If you want to see the output of a value, use print(...) in your code.
    The current working directory and any provided files are accessible.
    """
    warning = _check_code_safety(code)
    if warning:
        return warning
    return _python_repl.run(code)


_MAX_FILE_CHARS = 10_000
_TRUNCATION_OVERHEAD = 200  # budget for the ellipsis marker


def _truncate_content(content: str, max_chars: int = _MAX_FILE_CHARS) -> str:
    """Truncate content by keeping head and tail, replacing middle with an ellipsis."""
    if len(content) <= max_chars:
        return content
    tail_budget = max_chars // 3
    head_budget = max_chars - tail_budget - _TRUNCATION_OVERHEAD
    head = content[:head_budget]
    tail = content[-tail_budget:]
    head_lines = head.count("\n") + 1
    tail_lines = tail.count("\n") + 1
    total_lines = content.count("\n") + 1
    omitted = total_lines - head_lines - tail_lines
    return f'{head}\n\n... [{omitted} lines omitted] ...\n\n{tail}'


@tool
def read_file(file_path: str, max_lines: int = 0) -> str:
    """Read the contents of a file.

    Use this to read CSV data files, task descriptions, or other text files.
    Set max_lines to read only the first N lines (0 = entire file).
    Very long files are automatically truncated with the middle omitted.
    """
    path = Path(file_path)
    if not path.exists():
        return f"Error: file not found: {file_path}"
    try:
        lines = path.read_text().splitlines()
    except UnicodeDecodeError:
        suffix = path.suffix.lower()
        return (
            f"Error: {file_path} is a binary file ({suffix!r}) "
            f"and cannot be read as text. Use python_repl with "
            f"pd.read_excel(), pd.read_csv(), or other appropriate "
            f"libraries to load this file instead."
        )
    if max_lines > 0:
        lines = lines[:max_lines]
    content = "\n".join(lines)
    return _truncate_content(content)


_SYSTEM_PROMPT = """You are a data science assistant with access to the following tools:
1. read_file — Read the contents of a file (CSV, text, etc.)
2. python_repl — Execute Python code (pandas, numpy, scikit-learn, etc.)

General guidelines:
- Data files can be very large. Always use read_file with max_lines=5 first to preview \
the structure and column names before loading with Python.
- Read relevant data files before attempting analysis
- Write and execute Python code to perform computations
- Print results clearly so they can be captured
- For modeling tasks, generate predictions and save them as CSV files
"""


class ReactBaselineAgent:
    """Simple react baseline agent using langchain's create_agent."""

    name = "react-baseline"

    def __init__(self, model_name: str = "deepseek-v4-flash") -> None:
        self.model_name = model_name
        llm = get_model(model_name)
        self.agent = create_agent(
            llm,
            [python_repl, read_file],
            system_prompt=_SYSTEM_PROMPT,
        )

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        """Run agent on an analysis task, return text response and trace."""
        file_info = ""
        if files:
            file_info = "\n\nAvailable data files:\n" + "\n".join(
                f"- {f}" for f in files
            )

        parts = []
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(file_info)

        result = self.agent.invoke(
            {"messages": [{"role": "user", "content": "\n\n".join(parts)}]}
        )
        response: str = result["messages"][-1].content
        trace = _serialize_messages(result["messages"])
        logger.debug("ReactBaselineAgent response: {}...", response[:100])
        return response, trace

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
    ) -> tuple[Path, AgentTrace]:
        """Run agent on a modeling task, return path to prediction CSV and trace."""
        output_path = train_path.parent / "submission.csv"
        parts = []
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(
            f"Training data: {train_path}\n"
            f"Test data: {test_path}\n"
            f"Sample submission: {sample_submission_path}\n"
            f"Save your predictions to: {output_path}\n\n"
            "Read the training data, build a model, generate predictions "
            "for the test data, and save them as a CSV file matching "
            f"the sample submission format to {output_path}."
        )

        result = self.agent.invoke(
            {"messages": [{"role": "user", "content": "\n\n".join(parts)}]}
        )
        trace = _serialize_messages(result["messages"])

        if not output_path.exists():
            logger.warning("Submission file not created at {}", output_path)
        return output_path, trace
