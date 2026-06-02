"""Datawise-style baseline agent for benchmark evaluation."""

import base64
import re
import tempfile
from pathlib import Path
from typing import Any

from langchain.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage
from loguru import logger

from statigent.benchmarks.base import AgentTrace
from statigent.errors import StatigentBaselineError, StatigentSandboxError
from statigent.models import get_model
from statigent.retry import retry_on_conn_error
from statigent.sandbox.docker import DockerSandbox

_MAX_FILE_CHARS = 10_000
_TRUNCATION_OVERHEAD = 200
_PYTHON_BLOCK_RE = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL)
_CONTROL_MARKERS = (
    "<await>",
    "<end_step>",
    "<end_debug>",
    "<debug_failure>",
    "<debug_success>",
)

_SYSTEM_PROMPT = """You are Datawise, a data science assistant working in a
notebook-like environment.

Workspace:
- ./input contains task data files. Treat it as read-only.
- ./working is writable scratch space for intermediate files and scripts.
- ./display can hold artifacts you want to inspect.
- ./system is reserved for system files.

Workflow:
1. Plan the next concrete step before writing code.
2. Use Python code cells to inspect data and compute answers.
3. If a code cell fails, diagnose the error and run a corrected cell.
4. When the benchmark task is complete, respond with <end_step> followed by
   the final answer only.

Response format:
- Start intermediate responses with <await>.
- Put executable Python in fenced ```python code blocks.
- Do not invent preprocessing, modeling choices, or output formats that
  contradict the task instructions.
- For data analysis tasks, answer the question directly after computing it.
- For data modeling tasks, save predictions to /workspace/submission.csv.
"""


def _truncate_content(content: str, max_chars: int = _MAX_FILE_CHARS) -> str:
    """Truncate content by keeping head and tail with an omission marker."""
    if len(content) <= max_chars:
        return content
    tail_budget = max_chars // 3
    head_budget = max_chars - tail_budget - _TRUNCATION_OVERHEAD
    head = content[:head_budget]
    tail = content[-tail_budget:]
    omitted = content.count("\n") + 1 - head.count("\n") - tail.count("\n") - 2
    return f"{head}\n\n... [{max(omitted, 0)} lines omitted] ...\n\n{tail}"


def _extract_python_code_blocks(content: str) -> list[str]:
    """Extract Python code cells from a markdown response."""
    return [match.strip() for match in _PYTHON_BLOCK_RE.findall(content)]


def _message_content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    return str(content)


def _clean_final_response(content: str) -> str:
    cleaned = content.strip()
    for marker in _CONTROL_MARKERS:
        if cleaned.startswith(marker):
            cleaned = cleaned[len(marker) :].strip()
    return cleaned


def _usage_metadata(message: AIMessage) -> dict[str, int] | None:
    usage = message.usage_metadata
    if not usage:
        return None
    return {
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }


class DatawiseBaselineAgent:
    """Datawise-inspired notebook-loop baseline agent."""

    name = "datawise"

    def __init__(
        self,
        model_name: str = "deepseek-v4-flash",
        sandbox_image: str = "statigent/ds-sandbox",
        sandbox_network: bool = False,
        sandbox_timeout: int = 600,
        max_iterations: int = 6,
    ) -> None:
        self.model_name = model_name
        self.sandbox_image = sandbox_image
        self.sandbox_network = sandbox_network
        self.sandbox_timeout = sandbox_timeout
        self.max_iterations = max_iterations

    def _make_sandbox(self) -> DockerSandbox:
        return DockerSandbox(
            image=self.sandbox_image,
            network=self.sandbox_network,
            timeout=self.sandbox_timeout,
        )

    @staticmethod
    def _remap_to_container(
        local_files: list[Path],
        prefix: str = "/workspace/input",
    ) -> tuple[list[tuple[Path, str, bool]], dict[Path, Path]]:
        """Remap local file paths to neutral read-only container paths."""
        dir_to_container: dict[Path, str] = {}
        path_map: dict[Path, Path] = {}
        for file_path in local_files:
            parent = file_path.resolve().parent
            if parent not in dir_to_container:
                dir_to_container[parent] = f"{prefix}/{len(dir_to_container)}"
            path_map[file_path] = Path(dir_to_container[parent]) / file_path.name

        mounts = [
            (local_dir, container_dir, True)
            for local_dir, container_dir in sorted(dir_to_container.items())
        ]
        return mounts, path_map

    @staticmethod
    def _build_analysis_message(
        prompt: str,
        *,
        container_files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> str:
        parts = [
            "Use the workspace layout from the system prompt. Available data "
            "files are under ./input.",
        ]
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        if container_files:
            files = "\n".join(f"- {path}" for path in container_files)
            parts.append(f"Available data files:\n{files}")
        return "\n\n".join(parts)

    @staticmethod
    def _build_modeling_message(
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
    ) -> str:
        parts = [
            "Use the workspace layout from the system prompt. Build a "
            "predictive model and save the final CSV to /workspace/submission.csv.",
        ]
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(
            f"Training data: {train_path}\n"
            f"Test data: {test_path}\n"
            f"Sample submission: {sample_submission_path}\n"
            "The saved submission must match the sample submission columns."
        )
        return "\n\n".join(parts)

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        """Run a data analysis task and return the final response and trace."""
        with self._make_sandbox() as sandbox:
            if files:
                mounts, path_map = self._remap_to_container(files)
            else:
                mounts, path_map = [], {}
            sandbox.start(mounts)
            self._prepare_workspace(sandbox)

            container_files = (
                [path_map[file_path] for file_path in files] if files else None
            )
            user_message = self._build_analysis_message(
                prompt,
                container_files=container_files,
                task_instructions=task_instructions,
            )
            response, trace = self._run_notebook_loop(sandbox, user_message)
            logger.debug("DatawiseBaselineAgent response: {}...", response[:300])
            return response, trace

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
        work_dir: Path | None = None,
    ) -> tuple[Path, AgentTrace]:
        """Run a modeling task and return the generated submission CSV path."""
        with self._make_sandbox() as sandbox:
            local_files = [train_path, test_path, sample_submission_path]
            mounts, path_map = self._remap_to_container(local_files)
            sandbox.start(mounts)
            self._prepare_workspace(sandbox)

            user_message = self._build_modeling_message(
                prompt,
                train_path=path_map[train_path],
                test_path=path_map[test_path],
                sample_submission_path=path_map[sample_submission_path],
                task_instructions=task_instructions,
            )
            _response, trace = self._run_notebook_loop(sandbox, user_message)

            if work_dir is not None:
                work_dir.mkdir(parents=True, exist_ok=True)
                output_path = work_dir / "submission.csv"
            else:
                output_path = Path(tempfile.mkdtemp()) / "submission.csv"
            try:
                sandbox.get_file("/workspace/submission.csv", output_path)
            except StatigentSandboxError:
                logger.warning("Submission file not created in sandbox")
            return output_path, trace

    def _prepare_workspace(self, sandbox: DockerSandbox) -> None:
        sandbox.exec(
            "mkdir -p /workspace/input /workspace/working "
            "/workspace/display /workspace/system"
        )

    def _run_notebook_loop(
        self,
        sandbox: DockerSandbox,
        user_message: str,
    ) -> tuple[str, AgentTrace]:
        model = get_model(self.model_name)
        messages: list[AnyMessage] = [
            SystemMessage(content=_SYSTEM_PROMPT),
            HumanMessage(content=user_message),
        ]
        trace: AgentTrace = [{"role": "user", "content": user_message}]
        last_response = ""

        for _iteration in range(self.max_iterations):
            response = retry_on_conn_error(model.invoke)(messages)
            if not isinstance(response, AIMessage):
                raise StatigentBaselineError(
                    f"Model returned {type(response).__name__}, expected AIMessage"
                )

            content = _message_content_text(response.content)
            last_response = content
            assistant_entry: dict[str, Any] = {
                "role": "assistant",
                "content": content,
            }
            usage = _usage_metadata(response)
            if usage is not None:
                assistant_entry["usage_metadata"] = usage
            trace.append(assistant_entry)
            messages.append(response)

            code_blocks = _extract_python_code_blocks(content)
            if not code_blocks:
                break

            observations: list[str] = []
            for index, code in enumerate(code_blocks, start=1):
                output = self._execute_python_cell(sandbox, code)
                observations.append(f"Python cell {index} output:\n{output}")
                trace.append(
                    {
                        "role": "tool",
                        "name": "python",
                        "content": output,
                    }
                )

            messages.append(
                HumanMessage(
                    content=(
                        "Execution results from the Python cells:\n\n"
                        + "\n\n".join(observations)
                        + "\n\nContinue the workflow. If the task is complete, "
                        "respond with <end_step> and the final answer."
                    )
                )
            )

        return _clean_final_response(last_response), trace

    def _execute_python_cell(self, sandbox: DockerSandbox, code: str) -> str:
        encoded = base64.b64encode(code.encode()).decode()
        command = (
            f"echo {encoded} | base64 -d > /workspace/working/_datawise_cell.py"
            " && python /workspace/working/_datawise_cell.py"
        )
        return _truncate_content(sandbox.exec(command))
