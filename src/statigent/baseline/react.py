"""React baseline agent with built-in tools."""

import base64
import shlex
import tempfile
from pathlib import Path
from typing import Any

from langchain.agents import create_agent
from langchain.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
from langchain.tools import BaseTool, tool
from loguru import logger

from statigent.benchmarks.base import AgentTrace
from statigent.errors import StatigentSandboxError
from statigent.models import get_model
from statigent.retry import retry_on_conn_error
from statigent.sandbox.docker import DockerSandbox

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
    return f"{head}\n\n... [{omitted} lines omitted] ...\n\n{tail}"


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


def make_bash_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def bash(command: str) -> str:
        """Run a bash command in the workspace.

        Use this for shell operations like managing files,
        running scripts, or chaining commands.
        Each call runs in a fresh process — variables do not persist.
        Save intermediate results to files in /workspace/ to share
        state between calls.
        """
        return _truncate_content(sandbox.exec(command))

    return bash


def make_python_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def python(code: str) -> str:
        """Execute Python code and return the output.

        Each call starts a fresh interpreter — import modules and load
        data in every call. Save intermediate results to files in
        /workspace/ to share state between calls.
        If you want to see the output of a value, use print(...) in your code.
        """
        encoded = base64.b64encode(code.encode()).decode()
        cmd = (
            f"echo {encoded} | base64 -d > /tmp/_statigent_exec.py"
            f" && python /tmp/_statigent_exec.py"
        )
        return _truncate_content(sandbox.exec(cmd))

    return python


def make_read_file_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def read_file(file_path: str, max_lines: int = 0) -> str:
        """Read the contents of a text file.

        Use this to read CSV and other plain text files. Set max_lines
        to read only the first N lines (0 = entire file). Very long
        files are automatically truncated with the middle omitted.
        """
        safe_path = shlex.quote(file_path)
        if max_lines > 0:
            cmd = f"head -n {max_lines} {safe_path}"
        else:
            cmd = f"cat {safe_path}"
        output = sandbox.exec(cmd)
        if "�" in output[:500]:
            return (
                f"Error: {file_path} appears to be a binary file "
                "(e.g., Excel, Parquet, image). Use the read_excel "
                "tool for Excel files, or the python tool with an "
                "appropriate library for other binary formats."
            )
        return _truncate_content(output)

    return read_file


def make_read_excel_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def read_excel(file_path: str, max_rows: int = 0) -> str:
        """Read an Excel file (.xlsx, .xls) and display its contents.

        Set max_rows to read only the first N rows (0 = all rows).
        Very large outputs are automatically truncated.
        """
        safe_path = repr(file_path)
        limit_clause = f", nrows={max_rows}" if max_rows > 0 else ""
        code = (
            f"import pandas as pd; "
            f"df = pd.read_excel({safe_path}{limit_clause}); "
            f"print(df.to_string())"
        )
        encoded = base64.b64encode(code.encode()).decode()
        cmd = (
            f"echo {encoded} | base64 -d > /tmp/_statigent_excel.py"
            f" && python /tmp/_statigent_excel.py"
        )
        return _truncate_content(sandbox.exec(cmd))

    return read_excel


def make_write_file_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def write_file(file_path: str, content: str) -> str:
        """Write content to a file.

        Use this to save results, create scripts, or write configuration
        files.
        """
        safe_path = shlex.quote(file_path)
        encoded = base64.b64encode(content.encode()).decode()
        cmd = f"echo {encoded} | base64 -d > {safe_path}"
        result = sandbox.exec(cmd)
        if result.startswith("Exit code:"):
            return f"Error writing file: {result}"
        return f"Successfully wrote to {file_path}"

    return write_file


def make_list_dir_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def list_dir(path: str = "/workspace") -> str:
        """List directory contents.

        Use this to explore the workspace, find data files, or check
        what outputs have been created.
        """
        return _truncate_content(sandbox.exec(f"ls -la {shlex.quote(path)}"))

    return list_dir


_SYSTEM_PROMPT = """You are a data science assistant with access to the following tools:
1. read_file — Read the contents of a text file (CSV, etc.)
2. read_excel — Read an Excel file (.xlsx, .xls)
3. write_file — Write content to a file
4. python — Execute Python code
5. bash — Run shell commands
6. list_dir — List directory contents

Your working directory is /workspace. Data files are located at the
paths specified in the task — use list_dir or read_file to explore them.

General guidelines:
- Each python and bash call starts a fresh process — import modules and \
load data in every call. Save intermediate results to files in /workspace/ \
to share state between calls.
- Data files can be very large. Always use read_file with max_lines=5 first \
to preview the structure and column names before loading with Python.
- Read relevant data files before attempting analysis
- Write and execute Python code to perform computations
- Print results clearly so they can be captured
"""

_LITE_SYSTEM_PROMPT = """You are a data science assistant with access to the following \
tools:
1. read_file — Read the contents of a text file (CSV, etc.)
2. read_excel — Read an Excel file (.xlsx, .xls)
3. python — Execute Python code

Your working directory is /workspace. Data files are located at the
paths specified in the task — use read_file or read_excel to preview them first.

General guidelines:
- Each python call starts a fresh interpreter — import modules and \
load data in every call.
- Data files can be very large. Always use read_file with max_lines=5 first \
to preview the structure and column names before loading with Python.
- Read relevant data files before attempting analysis
- Write and execute Python code to perform computations
- Print results clearly so they can be captured
"""


class ReactBaselineAgent:
    """Simple react baseline agent using langchain's create_agent."""

    name = "react"

    def __init__(
        self,
        model_name: str = "deepseek-v4-flash",
        sandbox_image: str = "statigent/ds-sandbox",
        sandbox_network: bool = False,
        sandbox_timeout: int = 600,
        lite_version: bool = True,
    ) -> None:
        self.model_name = model_name
        self.sandbox_image = sandbox_image
        self.sandbox_network = sandbox_network
        self.sandbox_timeout = sandbox_timeout
        self.lite_version = lite_version

    def _create_agent(self, sandbox: DockerSandbox) -> Any:
        if self.lite_version:
            tools = [
                make_read_file_tool(sandbox),
                make_read_excel_tool(sandbox),
                make_python_tool(sandbox),
            ]
        else:
            tools = [
                make_bash_tool(sandbox),
                make_python_tool(sandbox),
                make_read_file_tool(sandbox),
                make_read_excel_tool(sandbox),
                make_write_file_tool(sandbox),
                make_list_dir_tool(sandbox),
            ]
        llm = get_model(self.model_name)
        system_prompt = _LITE_SYSTEM_PROMPT if self.lite_version else _SYSTEM_PROMPT
        return create_agent(llm, tools, system_prompt=system_prompt)

    def _make_sandbox(self) -> DockerSandbox:
        return DockerSandbox(
            image=self.sandbox_image,
            network=self.sandbox_network,
            timeout=self.sandbox_timeout,
        )

    @staticmethod
    def _remap_to_container(
        local_files: list[Path],
        prefix: str = "/workspace/data",
    ) -> tuple[list[tuple[Path, str, bool]], dict[Path, Path]]:
        """Remap local file paths to neutral container paths.

        Returns:
            mounts: (local_dir, container_dir, read_only) for sandbox.start
            path_map: local file path → container file path
        """
        dir_to_container: dict[Path, str] = {}
        path_map: dict[Path, Path] = {}
        for f in local_files:
            parent = f.resolve().parent
            if parent not in dir_to_container:
                idx = len(dir_to_container)
                dir_to_container[parent] = f"{prefix}/{idx}"
            path_map[f] = Path(dir_to_container[parent]) / f.name

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
        file_info = ""
        if container_files:
            file_info = "\n\nAvailable data files:\n" + "\n".join(
                f"- {f}" for f in container_files
            )
        parts = []
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(file_info)
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
        parts = []
        if task_instructions:
            parts.append(task_instructions)
        parts.append(prompt)
        parts.append(
            f"Training data: {train_path}\n"
            f"Test data: {test_path}\n"
            f"Sample submission: {sample_submission_path}\n"
            f"Save your predictions to: /workspace/submission.csv\n\n"
            "Read the training data, build a model, generate predictions "
            "for the test data, and save them as a CSV file matching "
            "the sample submission format to /workspace/submission.csv."
        )
        return "\n\n".join(parts)

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        """Run agent on an analysis task, return text response and trace."""
        with self._make_sandbox() as sandbox:
            if files:
                mounts, path_map = self._remap_to_container(files)
            else:
                mounts, path_map = [], {}
            sandbox.start(mounts)
            agent = self._create_agent(sandbox)

            container_files = [path_map[f] for f in files] if files else None
            user_message = self._build_analysis_message(
                prompt,
                container_files=container_files,
                task_instructions=task_instructions,
            )
            result = retry_on_conn_error(agent.invoke)(
                {"messages": [HumanMessage(content=user_message)]}
            )
            response: str = result["messages"][-1].content
            trace = _serialize_messages(result["messages"])
            logger.debug("ReactBaselineAgent response: {}...", response[:300])
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
        """Run agent on a modeling task, return path to prediction CSV and trace."""
        with self._make_sandbox() as sandbox:
            local_files = [train_path, test_path, sample_submission_path]
            mounts, path_map = self._remap_to_container(local_files)
            sandbox.start(mounts)
            agent = self._create_agent(sandbox)

            user_message = self._build_modeling_message(
                prompt,
                train_path=path_map[train_path],
                test_path=path_map[test_path],
                sample_submission_path=path_map[sample_submission_path],
                task_instructions=task_instructions,
            )
            result = retry_on_conn_error(agent.invoke)(
                {"messages": [HumanMessage(content=user_message)]}
            )
            trace = _serialize_messages(result["messages"])

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
