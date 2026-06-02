"""MetaGPT Data Interpreter-style baseline agent for benchmark evaluation."""

import base64
import re
import tempfile
from dataclasses import dataclass
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

_PLAN_SYSTEM_PROMPT = """You are Data Interpreter, a data scientist who solves
data-related tasks by planning, writing Python code, executing it, and refining
the implementation when execution fails.
"""

_CODE_SYSTEM_PROMPT = """As a data scientist, help the user achieve their goal
step by step in a continuous notebook-like Python environment.

Constraints:
- Write code for only the current step, not the whole task at once.
- Always output one and only one Python code block.
- The code runs in /workspace and can read ./input and write ./working.
- Do not use notebook shell syntax such as !pip.
- Respect benchmark instructions and required output formats.
"""

_REFLECTION_SYSTEM_PROMPT = """You are an AI Python assistant. You are given the
previous implementation code, the runtime result, and the original requirement.
Analyze the error and write a corrected implementation for the same step.
Always output one and only one Python code block.
"""


@dataclass(frozen=True)
class _ExecutionResult:
    code: str
    output: str
    success: bool


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


def _extract_python_code_block(content: str) -> str:
    """Extract the first Python code block from markdown content."""
    match = _PYTHON_BLOCK_RE.search(content)
    if match is None:
        return ""
    return match.group(1).strip()


def _message_content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    return str(content)


def _usage_metadata(message: AIMessage) -> dict[str, int] | None:
    usage = message.usage_metadata
    if not usage:
        return None
    return {
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }


class DataInterpreterBaselineAgent:
    """MetaGPT Data Interpreter-inspired baseline agent."""

    name = "data_interpreter"

    def __init__(
        self,
        model_name: str = "deepseek-v4-flash",
        sandbox_image: str = "statigent/ds-sandbox",
        sandbox_network: bool = False,
        sandbox_timeout: int = 600,
        max_tasks: int = 4,
        max_retries: int = 3,
    ) -> None:
        self.model_name = model_name
        self.sandbox_image = sandbox_image
        self.sandbox_network = sandbox_network
        self.sandbox_timeout = sandbox_timeout
        self.max_tasks = max_tasks
        self.max_retries = max_retries

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
            "Workspace: ./input contains read-only data files; ./working is "
            "writable scratch space; /workspace is the working directory.",
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
            "Workspace: ./input contains read-only data files; ./working is "
            "writable scratch space; /workspace is the working directory.",
        ]
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(
            f"Training data: {train_path}\n"
            f"Test data: {test_path}\n"
            f"Sample submission: {sample_submission_path}\n"
            "Build the model, generate test predictions, and save the final "
            "CSV to /workspace/submission.csv with the sample submission columns."
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
            response, trace = self._run_interpreter_loop(sandbox, user_message)
            logger.debug("DataInterpreterBaselineAgent response: {}...", response[:300])
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
            _response, trace = self._run_interpreter_loop(sandbox, user_message)

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
        sandbox.exec("mkdir -p /workspace/input /workspace/working")

    def _run_interpreter_loop(
        self,
        sandbox: DockerSandbox,
        user_message: str,
    ) -> tuple[str, AgentTrace]:
        model = get_model(self.model_name)
        trace: AgentTrace = [{"role": "user", "content": user_message}]
        plan = self._create_plan(model, user_message, trace)
        memory: list[str] = []

        for task_index in range(1, self.max_tasks + 1):
            execution = self._write_execute_and_reflect(
                model,
                sandbox,
                user_message=user_message,
                plan=plan,
                memory=memory,
                task_index=task_index,
                trace=trace,
            )
            memory.append(
                f"Task {task_index} code:\n{execution.code}\n\n"
                f"Task {task_index} output:\n{execution.output}"
            )
            if not execution.success:
                break

        final_answer = self._create_final_answer(
            model,
            user_message,
            plan,
            memory,
            trace,
        )
        return final_answer, trace

    def _create_plan(
        self,
        model: Any,
        user_message: str,
        trace: AgentTrace,
    ) -> str:
        messages: list[AnyMessage] = [
            SystemMessage(content=_PLAN_SYSTEM_PROMPT),
            HumanMessage(
                content=(
                    "# User Requirement\n"
                    f"{user_message}\n\n"
                    "# Instruction\n"
                    "Create a concise numbered plan for solving the task through "
                    "Python execution. Keep it actionable."
                )
            ),
        ]
        response = self._invoke_ai(model, messages)
        plan = _message_content_text(response.content)
        trace.append(self._assistant_trace("plan", plan, response))
        return plan

    def _write_execute_and_reflect(
        self,
        model: Any,
        sandbox: DockerSandbox,
        *,
        user_message: str,
        plan: str,
        memory: list[str],
        task_index: int,
        trace: AgentTrace,
    ) -> _ExecutionResult:
        previous_code = ""
        previous_output = ""
        for attempt in range(self.max_retries):
            if attempt == 0:
                response = self._write_code(
                    model,
                    user_message=user_message,
                    plan=plan,
                    memory=memory,
                    task_index=task_index,
                )
                event_name = "write_code"
            else:
                response = self._reflect_code(
                    model,
                    user_message=user_message,
                    plan=plan,
                    memory=memory,
                    previous_code=previous_code,
                    previous_output=previous_output,
                )
                event_name = "reflect_code"

            content = _message_content_text(response.content)
            code = _extract_python_code_block(content)
            if not code:
                trace.append(self._assistant_trace("missing_code", content, response))
                return _ExecutionResult(
                    code="",
                    output=(
                        "Data Interpreter did not return executable Python code. "
                        f"Assistant response:\n{content}"
                    ),
                    success=False,
                )
            trace.append(self._assistant_trace(event_name, content, response))

            output = self._execute_python_cell(sandbox, code)
            success = not output.startswith("Exit code:")
            trace.append(
                {
                    "role": "tool",
                    "name": "execute_code",
                    "content": output,
                    "metadata": {
                        "task_index": task_index,
                        "attempt": attempt + 1,
                        "success": success,
                    },
                }
            )
            if success:
                return _ExecutionResult(code=code, output=output, success=True)
            previous_code = code
            previous_output = output

        return _ExecutionResult(
            code=previous_code,
            output=previous_output,
            success=False,
        )

    def _write_code(
        self,
        model: Any,
        *,
        user_message: str,
        plan: str,
        memory: list[str],
        task_index: int,
    ) -> AIMessage:
        return self._invoke_ai(
            model,
            [
                SystemMessage(content=_CODE_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        "# User Requirement\n"
                        f"{user_message}\n\n"
                        "# Plan Status\n"
                        f"{plan}\n\n"
                        "# Working Memory\n"
                        f"{self._memory_text(memory)}\n\n"
                        "# Current Task\n"
                        f"Write executable Python for plan step {task_index}."
                    )
                ),
            ],
        )

    def _reflect_code(
        self,
        model: Any,
        *,
        user_message: str,
        plan: str,
        memory: list[str],
        previous_code: str,
        previous_output: str,
    ) -> AIMessage:
        return self._invoke_ai(
            model,
            [
                SystemMessage(content=_REFLECTION_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        "# User Requirement\n"
                        f"{user_message}\n\n"
                        "# Plan Status\n"
                        f"{plan}\n\n"
                        "# Working Memory\n"
                        f"{self._memory_text(memory)}\n\n"
                        "# Previous Code\n"
                        f"```python\n{previous_code}\n```\n\n"
                        "# Runtime Result\n"
                        f"{previous_output}\n\n"
                        "# Instruction\n"
                        "Write corrected executable Python for the same step."
                    )
                ),
            ],
        )

    def _create_final_answer(
        self,
        model: Any,
        user_message: str,
        plan: str,
        memory: list[str],
        trace: AgentTrace,
    ) -> str:
        response = self._invoke_ai(
            model,
            [
                SystemMessage(content=_PLAN_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        "# User Requirement\n"
                        f"{user_message}\n\n"
                        "# Plan\n"
                        f"{plan}\n\n"
                        "# Execution Results\n"
                        f"{self._memory_text(memory)}\n\n"
                        "# Instruction\n"
                        "Return the final answer. For modeling tasks, summarize "
                        "that /workspace/submission.csv has been saved if the "
                        "execution results show it."
                    )
                ),
            ],
        )
        final_answer = _message_content_text(response.content).strip()
        trace.append(self._assistant_trace("final_answer", final_answer, response))
        return final_answer

    def _invoke_ai(self, model: Any, messages: list[AnyMessage]) -> AIMessage:
        response = retry_on_conn_error(model.invoke)(messages)
        if not isinstance(response, AIMessage):
            raise StatigentBaselineError(
                f"Model returned {type(response).__name__}, expected AIMessage"
            )
        return response

    def _execute_python_cell(self, sandbox: DockerSandbox, code: str) -> str:
        encoded = base64.b64encode(code.encode()).decode()
        command = (
            f"echo {encoded} | base64 -d > /workspace/working/_data_interpreter_cell.py"
            " && python /workspace/working/_data_interpreter_cell.py"
        )
        return _truncate_content(sandbox.exec(command))

    @staticmethod
    def _memory_text(memory: list[str]) -> str:
        if not memory:
            return "<empty>"
        return "\n\n".join(memory)

    @staticmethod
    def _assistant_trace(
        name: str,
        content: str,
        message: AIMessage,
    ) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "role": "assistant",
            "name": name,
            "content": content,
        }
        usage = _usage_metadata(message)
        if usage is not None:
            entry["usage_metadata"] = usage
        return entry
