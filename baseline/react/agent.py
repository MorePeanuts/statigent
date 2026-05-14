"""React baseline agent implementing the DataScienceAgent protocol."""

from pathlib import Path

from langchain.agents import create_agent
from loguru import logger

from statigent.models import get_model

from .tools import python_repl, read_file

_SYSTEM_PROMPT = """You are a data science assistant. You can:
1. Read data files using the read_file tool
2. Execute Python code using the python_repl tool to analyze data

When answering questions:
- Read the provided data files first
- Write Python code to compute the answer
- Always print the final answer in the required format
- If the question specifies an output format like @answer_name[value], follow it exactly
- Pay attention to constraints (rounding, specific libraries, etc.)
- For numerical answers, make sure to print them clearly

When doing modeling tasks:
- Read the training and test data
- Build a model using Python
- Generate predictions and save them to the specified output path as CSV
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
        self, prompt: str, *, files: list[Path] | None = None
    ) -> str:
        """Run agent on an analysis task, return text response."""
        file_info = ""
        if files:
            file_info = "\n\nAvailable data files:\n" + "\n".join(
                f"- {f}" for f in files
            )

        result = self.agent.invoke(
            {"messages": [{"role": "user", "content": prompt + file_info}]}
        )
        response = result["messages"][-1].content
        logger.debug("ReactBaselineAgent response: {}...", response[:100])
        return response

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
    ) -> Path:
        """Run agent on a modeling task, return path to prediction CSV."""
        output_path = train_path.parent / "submission.csv"
        full_prompt = (
            f"{prompt}\n\n"
            f"Training data: {train_path}\n"
            f"Test data: {test_path}\n"
            f"Sample submission: {sample_submission_path}\n"
            f"Save your predictions to: {output_path}\n\n"
            "Read the training data, build a model, generate predictions "
            "for the test data, and save them as a CSV file matching "
            f"the sample submission format to {output_path}."
        )

        self.agent.invoke({"messages": [{"role": "user", "content": full_prompt}]})

        if not output_path.exists():
            logger.warning("Submission file not created at {}", output_path)
        return output_path
