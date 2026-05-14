"""React baseline agent with built-in tools."""

from pathlib import Path

from langchain.agents import create_agent
from langchain.tools import tool
from langchain_experimental.utilities import PythonREPL
from loguru import logger

from statigent.models import get_model

_python_repl = PythonREPL()


@tool
def python_repl(code: str) -> str:
    """Execute Python code and return the output.

    Use this to run data analysis code (pandas, numpy, etc.).
    If you want to see the output of a value, use print(...) in your code.
    The current working directory and any provided files are accessible.
    """
    return _python_repl.run(code)


@tool
def read_file(file_path: str) -> str:
    """Read the contents of a file.

    Use this to read CSV data files, task descriptions, or other text files.
    """
    return Path(file_path).read_text()


_SYSTEM_PROMPT = """You are a data science assistant with access to the following tools:
1. read_file — Read the contents of a file (CSV, text, etc.)
2. python_repl — Execute Python code (pandas, numpy, scikit-learn, etc.)

General guidelines:
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
    ) -> str:
        """Run agent on an analysis task, return text response."""
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
        logger.debug("ReactBaselineAgent response: {}...", response[:100])
        return response

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
    ) -> Path:
        """Run agent on a modeling task, return path to prediction CSV."""
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

        self.agent.invoke(
            {"messages": [{"role": "user", "content": "\n\n".join(parts)}]}
        )

        if not output_path.exists():
            logger.warning("Submission file not created at {}", output_path)
        return output_path
