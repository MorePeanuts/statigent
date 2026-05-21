# Docker Sandbox for ReactBaselineAgent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-process PythonREPL with Docker-container-based execution, adding proper isolation and richer tools (bash, python, read_file, write_file, list_dir).

**Architecture:** Per-task Docker containers provide isolated execution. Data directories are bind-mounted read-only at their host paths inside the container, so adapter-provided paths work without rewriting. Output files go to `/workspace/` (container writable layer) and are extracted via `docker cp` after task completion.

**Tech Stack:** Docker, subprocess, langchain tools, pytest with mock

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/statigent/errors.py` | Modify | Add `StatigentSandboxError` |
| `src/statigent/sandbox/__init__.py` | Create | Export `DockerSandbox` |
| `src/statigent/sandbox/docker.py` | Create | `DockerSandbox` class (lifecycle, exec, file transfer) |
| `src/statigent/baseline/react.py` | Modify | Replace tools with sandbox-backed versions, refactor agent |
| `Dockerfile` | Create | Pre-built DS sandbox image |
| `README.md` | Modify | Add Docker prerequisite + baseline section |
| `pyproject.toml` | Modify | Remove `langchain-experimental` dependency |
| `tests/sandbox/__init__.py` | Create | Test package marker |
| `tests/sandbox/test_docker.py` | Create | Unit tests for DockerSandbox |
| `tests/baseline/test_react.py` | Modify | Update tests for sandbox-backed agent |

---

### Task 1: Add StatigentSandboxError and create sandbox package

**Files:**
- Modify: `src/statigent/errors.py`
- Create: `src/statigent/sandbox/__init__.py`
- Create: `src/statigent/sandbox/docker.py` (placeholder)
- Create: `tests/sandbox/__init__.py`

- [ ] **Step 1: Add StatigentSandboxError to errors.py**

```python
# Append to src/statigent/errors.py:

class StatigentSandboxError(StatigentError):
    """Error raised by the Docker sandbox."""
```

- [ ] **Step 2: Create sandbox package files**

`src/statigent/sandbox/__init__.py`:
```python
"""Docker sandbox for isolated agent execution."""

from statigent.sandbox.docker import DockerSandbox

__all__ = ['DockerSandbox']
```

`src/statigent/sandbox/docker.py` — create with a minimal stub so the import works:
```python
"""Docker-based sandbox for isolated command execution."""

import atexit
import subprocess
import uuid
from pathlib import Path
from typing import Any

from loguru import logger

from statigent.errors import StatigentSandboxError


class DockerSandbox:
    """Manages a Docker container for isolated command execution."""

    def __init__(
        self,
        image: str = "statigent/ds-sandbox",
        network: bool = False,
        workdir: str = "/workspace",
        timeout: int = 600,
    ) -> None:
        self._image = image
        self._network = network
        self._workdir = workdir
        self._timeout = timeout
        self._container_name: str = ""

    def start(self, mounts: list[tuple[Path, str, bool]]) -> None: ...
    def exec(self, cmd: str) -> str: ...
    def get_file(self, container_path: str, host_path: Path) -> None: ...
    def stop(self) -> None: ...
    def __enter__(self) -> "DockerSandbox": ...
    def __exit__(self, *exc: Any) -> None: ...
```

`tests/sandbox/__init__.py` — empty file:
```python
```

- [ ] **Step 3: Run type check and lint**

Run: `uv run mypy src/statigent/errors.py src/statigent/sandbox/ && uv run ruff check src/statigent/errors.py src/statigent/sandbox/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/statigent/errors.py src/statigent/sandbox/ tests/sandbox/
git commit -m "feat: add StatigentSandboxError and sandbox package skeleton"
```

---

### Task 2: Implement DockerSandbox class (TDD)

**Files:**
- Create: `tests/sandbox/test_docker.py`
- Create: `src/statigent/sandbox/docker.py` (full implementation)
- Modify: `src/statigent/sandbox/__init__.py`

Key design decisions:
- Container name uses UUID for collision avoidance
- `start()` checks Docker availability, creates container with bind mounts
- `exec()` runs command via `docker exec` with timeout; returns output string (not exception on error)
- `get_file()` extracts files from container via `docker cp`
- `stop()` is idempotent (safe to call multiple times)
- Context manager + `atexit` handler ensure cleanup
- Data directories are bind-mounted at their absolute host paths (read-only), so adapter-provided paths work without rewriting

- [ ] **Step 1: Write tests for DockerSandbox.\_\_init\_\_**

```python
# tests/sandbox/test_docker.py

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from statigent.errors import StatigentSandboxError
from statigent.sandbox.docker import DockerSandbox


class TestDockerSandboxInit:
    def test_default_params(self) -> None:
        sandbox = DockerSandbox()
        assert sandbox._image == "statigent/ds-sandbox"
        assert sandbox._network is False
        assert sandbox._workdir == "/workspace"
        assert sandbox._timeout == 600
        assert sandbox._container_name == ""

    def test_custom_params(self) -> None:
        sandbox = DockerSandbox(
            image="custom/image",
            network=True,
            workdir="/data",
            timeout=300,
        )
        assert sandbox._image == "custom/image"
        assert sandbox._network is True
        assert sandbox._workdir == "/data"
        assert sandbox._timeout == 300
```

- [ ] **Step 2: Verify DockerSandbox.\_\_init\_\_ works**

The `__init__` was already defined in the Task 1 stub. Verify the init tests pass:

Run: `uv run pytest tests/sandbox/test_docker.py::TestDockerSandboxInit -v`
Expected: PASS

- [ ] **Step 3: Run init tests**

Run: `uv run pytest tests/sandbox/test_docker.py::TestDockerSandboxInit -v`
Expected: PASS

- [ ] **Step 4: Write tests for DockerSandbox.start()**

```python
# Add to tests/sandbox/test_docker.py

class TestDockerSandboxStart:
    @patch("statigent.sandbox.docker.subprocess.run")
    def test_starts_container_with_mounts(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(stdout="abc123\n", returncode=0)
        sandbox = DockerSandbox()
        sandbox.start([
            (Path("/host/data"), "/host/data", True),
        ])
        assert sandbox._container_name == "abc123"
        call_args = mock_run.call_args
        cmd = call_args[0][0]
        assert cmd[0] == "docker"
        assert "run" in cmd
        assert "-d" in cmd
        assert "-v" in cmd
        assert "/host/data:/host/data:ro" in cmd
        assert "--network" in cmd
        assert "none" in cmd

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_starts_with_network_enabled(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(stdout="abc123\n", returncode=0)
        sandbox = DockerSandbox(network=True)
        sandbox.start([])
        call_args = mock_run.call_args
        cmd = call_args[0][0]
        assert "--network" not in cmd

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_raises_when_docker_not_installed(self, mock_run: MagicMock) -> None:
        mock_run.side_effect = FileNotFoundError
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="Docker is not installed"):
            sandbox.start([])

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_raises_when_docker_daemon_not_running(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=1, stderr="daemon not running")
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="Docker daemon"):
            sandbox.start([])

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_raises_when_container_start_fails(self, mock_run: MagicMock) -> None:
        # First call (docker info) succeeds, second (docker run) fails
        mock_run.side_effect = [
            MagicMock(returncode=0),
            subprocess.CalledProcessError(1, "docker run", stderr="image not found"),
        ]
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="Failed to start"):
            sandbox.start([])

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_registers_atexit_handler(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(stdout="abc123\n", returncode=0)
        sandbox = DockerSandbox()
        with patch("statigent.sandbox.docker.atexit") as mock_atexit:
            sandbox.start([])
            mock_atexit.register.assert_called_once_with(sandbox.stop)
```

- [ ] **Step 5: Implement DockerSandbox.start()**

```python
# Replace start() in src/statigent/sandbox/docker.py

    def start(self, mounts: list[tuple[Path, str, bool]]) -> None:
        """Start container with bind mounts.

        Each mount is (host_path, container_path, read_only).
        """
        self._check_docker_available()

        cmd: list[str] = ["docker", "run", "-d"]
        for host_path, container_path, read_only in mounts:
            mount_spec = f"{host_path}:{container_path}"
            if read_only:
                mount_spec += ":ro"
            cmd.extend(["-v", mount_spec])

        cmd.extend(["-w", self._workdir])
        if not self._network:
            cmd.extend(["--network", "none"])
        cmd.append(self._image)

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, check=True,
            )
        except subprocess.CalledProcessError as exc:
            raise StatigentSandboxError(
                f"Failed to start Docker container: {exc.stderr}"
            ) from exc

        self._container_name = result.stdout.strip()
        atexit.register(self.stop)
        logger.debug("DockerSandbox started container: {}", self._container_name)

    def _check_docker_available(self) -> None:
        """Check that Docker is installed and daemon is running."""
        try:
            subprocess.run(
                ["docker", "info"],
                capture_output=True,
                check=True,
            )
        except FileNotFoundError:
            raise StatigentSandboxError(
                "Docker is not installed. "
                "Please install Docker: https://docs.docker.com/get-docker/"
            )
        except subprocess.CalledProcessError:
            raise StatigentSandboxError(
                "Docker daemon is not running. Please start Docker."
            )
```

- [ ] **Step 6: Run start tests**

Run: `uv run pytest tests/sandbox/test_docker.py::TestDockerSandboxStart -v`
Expected: PASS

- [ ] **Step 7: Write tests for DockerSandbox.exec()**

```python
# Add to tests/sandbox/test_docker.py

class TestDockerSandboxExec:
    @patch("statigent.sandbox.docker.subprocess.run")
    def test_executes_command(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(
            stdout="hello world\n", stderr="", returncode=0,
        )
        sandbox = DockerSandbox()
        sandbox._container_name = "test-ctr"
        result = sandbox.exec("echo hello world")
        assert result == "hello world\n"

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_includes_stderr_on_error(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(
            stdout="", stderr="permission denied\n", returncode=1,
        )
        sandbox = DockerSandbox()
        sandbox._container_name = "test-ctr"
        result = sandbox.exec("cat /root/secret")
        assert "Exit code: 1" in result
        assert "permission denied" in result

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_returns_timeout_error(self, mock_run: MagicMock) -> None:
        mock_run.side_effect = subprocess.TimeoutExpired(
            cmd="docker exec", timeout=600,
        )
        sandbox = DockerSandbox()
        sandbox._container_name = "test-ctr"
        result = sandbox.exec("sleep 9999")
        assert "timed out" in result

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_raises_when_no_container(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="not started"):
            sandbox.exec("echo hello")
```

- [ ] **Step 8: Implement DockerSandbox.exec()**

```python
# Add to src/statigent/sandbox/docker.py

    def exec(self, cmd: str) -> str:
        """Run command in container, return stdout+stderr.

        Returns error string on timeout or non-zero exit code
        (does not raise exceptions for command failures).
        """
        if not self._container_name:
            raise StatigentSandboxError(
                "Container not started. Call start() first."
            )

        try:
            result = subprocess.run(
                ["docker", "exec", self._container_name, "bash", "-c", cmd],
                capture_output=True,
                text=True,
                timeout=self._timeout,
            )
        except subprocess.TimeoutExpired:
            return f"Error: command timed out after {self._timeout}s"

        output = result.stdout
        if result.stderr:
            output += result.stderr
        if result.returncode != 0:
            output = f"Exit code: {result.returncode}\n{output}"
        return output
```

- [ ] **Step 9: Run exec tests**

Run: `uv run pytest tests/sandbox/test_docker.py::TestDockerSandboxExec -v`
Expected: PASS

- [ ] **Step 10: Write tests for DockerSandbox.get_file()**

```python
# Add to tests/sandbox/test_docker.py

class TestDockerSandboxGetFile:
    @patch("statigent.sandbox.docker.subprocess.run")
    def test_copies_file_from_container(self, mock_run: MagicMock, tmp_path: Path) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        sandbox = DockerSandbox()
        sandbox._container_name = "test-ctr"
        host_path = tmp_path / "output.csv"
        sandbox.get_file("/workspace/submission.csv", host_path)
        call_args = mock_run.call_args
        cmd = call_args[0][0]
        assert cmd == ["docker", "cp", "test-ctr:/workspace/submission.csv", str(host_path)]

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_raises_when_copy_fails(self, mock_run: MagicMock, tmp_path: Path) -> None:
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "docker cp", stderr="file not found",
        )
        sandbox = DockerSandbox()
        sandbox._container_name = "test-ctr"
        with pytest.raises(StatigentSandboxError, match="Failed to copy"):
            sandbox.get_file("/workspace/missing.csv", tmp_path / "out.csv")
```

- [ ] **Step 11: Implement DockerSandbox.get_file()**

```python
# Add to src/statigent/sandbox/docker.py

    def get_file(self, container_path: str, host_path: Path) -> None:
        """Copy file from container to host via docker cp."""
        if not self._container_name:
            raise StatigentSandboxError(
                "Container not started. Call start() first."
            )

        try:
            subprocess.run(
                [
                    "docker", "cp",
                    f"{self._container_name}:{container_path}",
                    str(host_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError as exc:
            raise StatigentSandboxError(
                f"Failed to copy file from container: {exc.stderr}"
            ) from exc
```

- [ ] **Step 12: Run get_file tests**

Run: `uv run pytest tests/sandbox/test_docker.py::TestDockerSandboxGetFile -v`
Expected: PASS

- [ ] **Step 13: Write tests for DockerSandbox.stop() and context manager**

```python
# Add to tests/sandbox/test_docker.py

class TestDockerSandboxStop:
    @patch("statigent.sandbox.docker.subprocess.run")
    def test_stops_and_removes_container(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        sandbox = DockerSandbox()
        sandbox._container_name = "test-ctr"
        sandbox.stop()
        calls = mock_run.call_args_list
        assert any("stop" in str(c) for c in calls)
        assert any("rm" in str(c) for c in calls)
        assert sandbox._container_name == ""

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_idempotent(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        sandbox = DockerSandbox()
        sandbox._container_name = "test-ctr"
        sandbox.stop()
        sandbox.stop()  # second call should be no-op
        # docker stop + docker rm called once each
        assert mock_run.call_count == 2

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_noop_when_not_started(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox.stop()
        mock_run.assert_not_called()


class TestDockerSandboxContextManager:
    @patch("statigent.sandbox.docker.subprocess.run")
    def test_stops_on_exit(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(stdout="ctr\n", returncode=0)
        sandbox = DockerSandbox()
        sandbox.start([])
        container_name = sandbox._container_name
        with sandbox:
            pass
        assert sandbox._container_name == ""
```

- [ ] **Step 14: Implement DockerSandbox.stop()**

```python
# Add to src/statigent/sandbox/docker.py

    def stop(self) -> None:
        """Stop and remove the container. Idempotent."""
        if not self._container_name:
            return

        subprocess.run(
            ["docker", "stop", self._container_name],
            capture_output=True,
        )
        subprocess.run(
            ["docker", "rm", self._container_name],
            capture_output=True,
        )
        logger.debug("DockerSandbox stopped container: {}", self._container_name)
        self._container_name = ""

    def __enter__(self) -> "DockerSandbox":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop()
```

- [ ] **Step 15: Run stop and context manager tests**

Run: `uv run pytest tests/sandbox/test_docker.py::TestDockerSandboxStop tests/sandbox/test_docker.py::TestDockerSandboxContextManager -v`
Expected: PASS

- [ ] **Step 16: Run full test suite + type check + lint**

Run: `uv run pytest tests/sandbox/ -v && uv run mypy src/statigent/sandbox/ && uv run ruff check src/statigent/sandbox/ tests/sandbox/`
Expected: PASS

- [ ] **Step 17: Commit**

```bash
git add src/statigent/sandbox/ tests/sandbox/
git commit -m "feat: implement DockerSandbox class with lifecycle management"
```

---

### Task 3: Implement sandbox tools (TDD)

**Files:**
- Modify: `src/statigent/baseline/react.py`
- Modify: `tests/baseline/test_react.py`

The old tools (`python_repl`, `read_file` with `_check_code_safety`, `_DANGEROUS_PATTERNS`, `_python_repl`) are replaced with sandbox-backed tools (`bash`, `python`, `read_file`, `write_file`, `list_dir`). Each tool is created by a factory function that captures a `DockerSandbox` reference.

Key design decisions:
- No `sandbox_` prefix — the Docker layer is hidden from the agent
- `python` tool writes code to a temp file in the container and executes it (avoids quoting issues with `python -c`)
- Each tool call starts a fresh process — no variable persistence between calls. The system prompt instructs the agent to save intermediate results to `/workspace/`
- `_truncate_content()` is kept for long outputs
- Old safety checks (`_check_code_safety`, `_DANGEROUS_PATTERNS`) are removed — Docker provides real isolation

- [ ] **Step 1: Write tests for sandbox tools**

```python
# Add to tests/baseline/test_react.py

from statigent.sandbox.docker import DockerSandbox


class TestBashTool:
    @patch.object(DockerSandbox, "exec")
    def test_runs_bash_command(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "hello\n"
        sandbox = DockerSandbox()
        tool = make_bash_tool(sandbox)
        result = tool.invoke({"command": "echo hello"})
        mock_exec.assert_called_once_with("echo hello")
        assert result == "hello\n"


class TestPythonTool:
    @patch.object(DockerSandbox, "exec")
    def test_executes_python_code(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "5\n"
        sandbox = DockerSandbox()
        tool = make_python_tool(sandbox)
        result = tool.invoke({"code": "print(2 + 3)"})
        assert "5" in result

    @patch.object(DockerSandbox, "exec")
    def test_writes_code_to_temp_file(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = ""
        sandbox = DockerSandbox()
        tool = make_python_tool(sandbox)
        tool.invoke({"code": "import pandas as pd"})
        cmd = mock_exec.call_args[0][0]
        assert "/tmp/_statigent_exec.py" in cmd
        assert "python /tmp/_statigent_exec.py" in cmd

    @patch.object(DockerSandbox, "exec")
    def test_truncates_long_output(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "x\n" * 50_000
        sandbox = DockerSandbox()
        tool = make_python_tool(sandbox)
        result = tool.invoke({"code": "print('long')"})
        assert len(result) < 100_000


class TestReadFileTool:
    @patch.object(DockerSandbox, "exec")
    def test_reads_file(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "name,age\nAlice,30\n"
        sandbox = DockerSandbox()
        tool = make_read_file_tool(sandbox)
        result = tool.invoke({"file_path": "/workspace/data.csv"})
        assert "Alice" in result

    @patch.object(DockerSandbox, "exec")
    def test_reads_file_with_max_lines(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "line1\nline2\n"
        sandbox = DockerSandbox()
        tool = make_read_file_tool(sandbox)
        tool.invoke({"file_path": "/workspace/data.csv", "max_lines": 2})
        cmd = mock_exec.call_args[0][0]
        assert "head -n 2" in cmd

    @patch.object(DockerSandbox, "exec")
    def test_reads_file_no_max_lines(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "all content\n"
        sandbox = DockerSandbox()
        tool = make_read_file_tool(sandbox)
        tool.invoke({"file_path": "/workspace/data.csv", "max_lines": 0})
        cmd = mock_exec.call_args[0][0]
        assert "cat " in cmd


class TestWriteFileTool:
    @patch.object(DockerSandbox, "exec")
    def test_writes_file(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = ""
        sandbox = DockerSandbox()
        tool = make_write_file_tool(sandbox)
        result = tool.invoke({"file_path": "/workspace/output.txt", "content": "hello"})
        cmd = mock_exec.call_args[0][0]
        assert "cat >" in cmd
        assert "/workspace/output.txt" in cmd
        assert "hello" in cmd

    @patch.object(DockerSandbox, "exec")
    def test_returns_success_message(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = ""
        sandbox = DockerSandbox()
        tool = make_write_file_tool(sandbox)
        result = tool.invoke({"file_path": "/workspace/out.txt", "content": "x"})
        assert "Successfully" in result


class TestListDirTool:
    @patch.object(DockerSandbox, "exec")
    def test_lists_directory(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "total 8\ndrwxr-xr-x 2 root root 4096 .\n-rw-r--r-- 1 root root 100 data.csv\n"
        sandbox = DockerSandbox()
        tool = make_list_dir_tool(sandbox)
        result = tool.invoke({"path": "/workspace"})
        assert "data.csv" in result

    @patch.object(DockerSandbox, "exec")
    def test_default_path_is_workspace(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "total 0\n"
        sandbox = DockerSandbox()
        tool = make_list_dir_tool(sandbox)
        tool.invoke({})
        cmd = mock_exec.call_args[0][0]
        assert "/workspace" in cmd
```

- [ ] **Step 2: Implement sandbox tool factory functions**

Replace the old tool definitions in `src/statigent/baseline/react.py`. Remove:
- `_DANGEROUS_PATTERNS`
- `_check_code_safety()`
- `_python_repl`
- The old `python_repl` tool
- The old `read_file` tool

Keep:
- `_MAX_FILE_CHARS`, `_TRUNCATION_OVERHEAD`, `_truncate_content()` (used by new tools)

Add new tool factory functions:

```python
# Add to src/statigent/baseline/react.py (after _truncate_content)

import shlex

from langchain.tools import BaseTool, StructuredTool
from statigent.sandbox.docker import DockerSandbox


def make_bash_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def bash(command: str) -> str:
        """Run a bash command in the workspace.

        Use this for shell operations like installing packages,
        managing files, running scripts, or chaining commands.
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

        Use this to run data analysis code. Available packages: pandas,
        numpy, scikit-learn, scipy, xgboost, lightgbm, matplotlib,
        seaborn, torch.
        Each call starts a fresh interpreter — import modules and load
        data in every call. Save intermediate results to files in
        /workspace/ to share state between calls.
        If you want to see the output of a value, use print(...) in your code.
        """
        cmd = (
            f"cat > /tmp/_statigent_exec.py << 'STATIGENT_PYTHON_EOF'\n"
            f"{code}\n"
            f"STATIGENT_PYTHON_EOF\n"
            f"python /tmp/_statigent_exec.py"
        )
        return _truncate_content(sandbox.exec(cmd))
    return python


def make_read_file_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def read_file(file_path: str, max_lines: int = 0) -> str:
        """Read the contents of a file.

        Use this to read CSV data files, task descriptions, or other
        text files. Set max_lines to read only the first N lines
        (0 = entire file). Very long files are automatically truncated
        with the middle omitted.
        """
        safe_path = shlex.quote(file_path)
        if max_lines > 0:
            cmd = f"head -n {max_lines} {safe_path}"
        else:
            cmd = f"cat {safe_path}"
        return _truncate_content(sandbox.exec(cmd))
    return read_file


def make_write_file_tool(sandbox: DockerSandbox) -> BaseTool:
    @tool
    def write_file(file_path: str, content: str) -> str:
        """Write content to a file.

        Use this to save results, create scripts, or write configuration
        files.
        """
        safe_path = shlex.quote(file_path)
        cmd = (
            f"cat > {safe_path} << 'STATIGENT_WRITE_EOF'\n"
            f"{content}\n"
            f"STATIGENT_WRITE_EOF"
        )
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
        return sandbox.exec(f"ls -la {shlex.quote(path)}")
    return list_dir
```

Also update the imports at the top of `react.py`:
- Remove: `from langchain_experimental.utilities import PythonREPL`
- Add: `import shlex` and `from langchain.tools import BaseTool`
- Add: `from statigent.sandbox.docker import DockerSandbox`
- Remove: `import re` (only used by `_DANGEROUS_PATTERNS`)

- [ ] **Step 3: Run tool tests**

Run: `uv run pytest tests/baseline/test_react.py::TestBashTool tests/baseline/test_react.py::TestPythonTool tests/baseline/test_react.py::TestReadFileTool tests/baseline/test_react.py::TestWriteFileTool tests/baseline/test_react.py::TestListDirTool -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/statigent/baseline/react.py tests/baseline/test_react.py
git commit -m "feat: add sandbox-backed tools (bash, python, read_file, write_file, list_dir)"
```

---

### Task 4: Refactor ReactBaselineAgent to use DockerSandbox

**Files:**
- Modify: `src/statigent/baseline/react.py`
- Modify: `tests/baseline/test_react.py`

Key changes:
- `__init__` no longer creates `self.agent` — add `sandbox_image`, `sandbox_network`, `sandbox_timeout` params instead
- New `_create_agent(sandbox)` method creates a langchain agent with sandbox-bound tools
- `run_analysis_for_eval()` wraps execution in a DockerSandbox context manager
- `run_modeling_for_eval()` wraps execution in a DockerSandbox context manager, extracts output from container
- Data directories are mounted at their absolute host paths (read-only), so adapter-provided paths work without rewriting
- For modeling tasks, output goes to `/workspace/submission.csv` in the container, then extracted via `docker cp`
- System prompt is updated to reflect new tools and stateless execution model
- Remove old `_python_repl`, `_DANGEROUS_PATTERNS`, `_check_code_safety`, and `from langchain_experimental` import

- [ ] **Step 1: Update system prompt**

```python
# Replace _SYSTEM_PROMPT in src/statigent/baseline/react.py

_SYSTEM_PROMPT = """You are a data science assistant with access to the following tools:
1. read_file — Read the contents of a file (CSV, text, etc.)
2. write_file — Write content to a file
3. python — Execute Python code (pandas, numpy, scikit-learn, etc.)
4. bash — Run shell commands
5. list_dir — List directory contents

Your working directory is /workspace. All data files are located here.

General guidelines:
- Each python and bash call starts a fresh process — import modules and \
load data in every call. Save intermediate results to files in /workspace/ \
to share state between calls.
- Data files can be very large. Always use read_file with max_lines=5 first \
to preview the structure and column names before loading with Python.
- Read relevant data files before attempting analysis
- Write and execute Python code to perform computations
- Print results clearly so they can be captured
- For modeling tasks, generate predictions and save them as CSV files
"""
```

- [ ] **Step 2: Refactor ReactBaselineAgent class**

```python
# Replace the ReactBaselineAgent class in src/statigent/baseline/react.py

class ReactBaselineAgent:
    """React baseline agent using langchain create_agent with Docker sandbox."""

    name = "react-baseline"

    def __init__(
        self,
        model_name: str = "deepseek-v4-flash",
        sandbox_image: str = "statigent/ds-sandbox",
        sandbox_network: bool = False,
        sandbox_timeout: int = 600,
    ) -> None:
        self.model_name = model_name
        self.sandbox_image = sandbox_image
        self.sandbox_network = sandbox_network
        self.sandbox_timeout = sandbox_timeout

    def _create_agent(self, sandbox: DockerSandbox) -> Any:
        """Create a langchain agent with tools bound to the given sandbox."""
        tools = [
            make_bash_tool(sandbox),
            make_python_tool(sandbox),
            make_read_file_tool(sandbox),
            make_write_file_tool(sandbox),
            make_list_dir_tool(sandbox),
        ]
        llm = get_model(self.model_name)
        return create_agent(llm, tools, system_prompt=_SYSTEM_PROMPT)

    def _make_sandbox(self) -> DockerSandbox:
        """Create a DockerSandbox with this agent's configuration."""
        return DockerSandbox(
            image=self.sandbox_image,
            network=self.sandbox_network,
            timeout=self.sandbox_timeout,
        )

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        """Run agent on an analysis task, return text response and trace."""
        with self._make_sandbox() as sandbox:
            mounts = self._build_analysis_mounts(files)
            sandbox.start(mounts)
            agent = self._create_agent(sandbox)

            user_message = self._build_analysis_message(
                prompt, files=files, task_instructions=task_instructions,
            )
            result = retry_on_conn_error(agent.invoke)(
                {"messages": [{"role": "user", "content": user_message}]}
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
        with self._make_sandbox() as sandbox:
            data_dir = train_path.resolve()
            if not data_dir.is_dir():
                data_dir = data_dir.parent
            mounts = [(data_dir, str(data_dir), True)]
            sandbox.start(mounts)
            agent = self._create_agent(sandbox)

            user_message = self._build_modeling_message(
                prompt,
                train_path=train_path,
                test_path=test_path,
                sample_submission_path=sample_submission_path,
                task_instructions=task_instructions,
            )
            result = retry_on_conn_error(agent.invoke)(
                {"messages": [{"role": "user", "content": user_message}]}
            )
            trace = _serialize_messages(result["messages"])

            output_path = Path(tempfile.mkdtemp()) / "submission.csv"
            try:
                sandbox.get_file("/workspace/submission.csv", output_path)
            except StatigentSandboxError:
                logger.warning("Submission file not created in sandbox")
            return output_path, trace

    @staticmethod
    def _build_analysis_mounts(
        files: list[Path] | None,
    ) -> list[tuple[Path, str, bool]]:
        """Build mount list for analysis tasks.

        Mounts data directories at their absolute host paths (read-only)
        so adapter-provided paths work without rewriting.
        """
        if not files:
            return []
        dirs = {f.resolve().parent for f in files}
        return [(d, str(d), True) for d in sorted(dirs)]

    @staticmethod
    def _build_analysis_message(
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> str:
        """Construct the user message for analysis tasks."""
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
        """Construct the user message for modeling tasks."""
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
            f"the sample submission format to /workspace/submission.csv."
        )
        return "\n\n".join(parts)
```

Also add the new imports at the top of `react.py`:
```python
import tempfile
```

And import `StatigentSandboxError`:
```python
from statigent.errors import StatigentSandboxError
```

- [ ] **Step 3: Update tests for ReactBaselineAgent**

Remove old test classes: `TestPythonReplTool`, `TestReadFileTool` (old in-process tools are gone).

Update `TestReactBaselineAgentInit` — agent no longer creates `self.agent` in `__init__`:

```python
# Replace TestReactBaselineAgentInit in tests/baseline/test_react.py

class TestReactBaselineAgentInit:
    def test_default_params(self) -> None:
        agent = ReactBaselineAgent()
        assert agent.model_name == "deepseek-v4-flash"
        assert agent.sandbox_image == "statigent/ds-sandbox"
        assert agent.sandbox_network is False
        assert agent.sandbox_timeout == 600

    def test_custom_params(self) -> None:
        agent = ReactBaselineAgent(
            model_name="gpt-4o",
            sandbox_image="custom/image",
            sandbox_network=True,
            sandbox_timeout=300,
        )
        assert agent.model_name == "gpt-4o"
        assert agent.sandbox_image == "custom/image"
        assert agent.sandbox_network is True
        assert agent.sandbox_timeout == 300
```

Update `TestRunAnalysisForEval` — now uses DockerSandbox:

```python
# Replace TestRunAnalysisForEval in tests/baseline/test_react.py

class TestRunAnalysisForEval:
    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_returns_response_and_trace(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [
                HumanMessage(content="What is the mean age?"),
                AIMessage(content="The mean age is 30"),
            ]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        response, trace = agent.run_analysis_for_eval("What is the mean age?")
        assert response == "The mean age is 30"
        assert len(trace) == 2
        assert trace[0]["role"] == "user"
        assert trace[1]["role"] == "assistant"
        mock_start.assert_called_once()
        mock_stop.assert_called_once()

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_includes_files_in_message(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        agent.run_analysis_for_eval(
            "Analyze",
            files=[Path("/data/train.csv"), Path("/data/test.csv")],
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "/data/train.csv" in msg["content"]
        assert "/data/test.csv" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_includes_task_instructions(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        agent.run_analysis_for_eval(
            "Analyze",
            task_instructions="Answer in JSON format",
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "Answer in JSON format" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_no_files_no_task_instructions(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        agent.run_analysis_for_eval("What is 2+2?")
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "What is 2+2?" in msg["content"]
        assert "Available data files" not in msg["content"]
```

Update `TestRunModelingForEval` — now uses DockerSandbox and `/workspace/submission.csv`:

```python
# Replace TestRunModelingForEval in tests/baseline/test_react.py

class TestRunModelingForEval:
    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "get_file")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_returns_output_path_and_trace(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_get_file: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [
                HumanMessage(content="Build a model"),
                AIMessage(content="Done"),
            ]
        }
        mock_create_agent.return_value = mock_agent

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        result_path, trace = agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
        )
        assert result_path.name == "submission.csv"
        assert len(trace) == 2
        mock_start.assert_called_once()
        mock_stop.assert_called_once()

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "get_file")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_includes_paths_in_message(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_get_file: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert str(train) in msg["content"]
        assert str(test) in msg["content"]
        assert str(sample) in msg["content"]
        assert "/workspace/submission.csv" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "get_file")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_includes_task_instructions(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_get_file: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
            task_instructions="Use random forest",
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "Use random forest" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    @patch.object(DockerSandbox, "get_file")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    def test_warns_when_submission_not_created(
        self,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_get_file: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent
        mock_get_file.side_effect = StatigentSandboxError("not found")

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        with patch("statigent.baseline.react.logger") as mock_logger:
            result_path, _trace = agent.run_modeling_for_eval(
                "Build a model",
                train_path=train,
                test_path=test,
                sample_submission_path=sample,
            )
            mock_logger.warning.assert_called_once()
        assert not result_path.exists()
```

Update `TestProtocolConformance`:

```python
# Replace TestProtocolConformance in tests/baseline/test_react.py

class TestProtocolConformance:
    def test_satisfies_data_science_agent_protocol(self) -> None:
        agent = ReactBaselineAgent()
        assert agent.name == "react-baseline"
        assert hasattr(agent, "run_analysis_for_eval")
        assert hasattr(agent, "run_modeling_for_eval")
        assert agent.model_name == "deepseek-v4-flash"
```

Remove the old `TestPythonReplTool` and `TestReadFileTool` classes entirely.

Update the test file imports:
```python
# Remove these imports:
# from statigent.baseline.react import _check_code_safety, python_repl, read_file

# Add these imports:
from statigent.baseline.react import (
    _SYSTEM_PROMPT,
    ReactBaselineAgent,
    _serialize_messages,
    make_bash_tool,
    make_list_dir_tool,
    make_python_tool,
    make_read_file_tool,
    make_write_file_tool,
)
from statigent.errors import StatigentSandboxError
from statigent.sandbox.docker import DockerSandbox
```

Also update `TestSerializeMessages` — the tool name references need to change from `"python_repl"` to `"python"`:

```python
class TestSerializeMessages:
    def test_serializes_human_message(self) -> None:
        msgs = [HumanMessage(content="What is the mean?")]
        trace = _serialize_messages(msgs)
        assert trace[0] == {"role": "user", "content": "What is the mean?"}

    def test_serializes_ai_message_with_tool_calls(self) -> None:
        msgs = [
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "python", "args": {"code": "print(1)"}, "id": "tc1"}
                ],
            )
        ]
        trace = _serialize_messages(msgs)
        assert trace[0]["role"] == "assistant"
        assert trace[0]["content"] == ""
        assert len(trace[0]["tool_calls"]) == 1
        assert trace[0]["tool_calls"][0]["name"] == "python"

    def test_serializes_tool_message(self) -> None:
        msgs = [ToolMessage(content="42", name="python", tool_call_id="tc1")]
        trace = _serialize_messages(msgs)
        assert trace[0] == {
            "role": "tool",
            "name": "python",
            "content": "42",
            "tool_call_id": "tc1",
        }

    def test_serializes_full_conversation(self) -> None:
        msgs = [
            HumanMessage(content="Analyze this"),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "read_file",
                        "args": {"file_path": "/data.csv"},
                        "id": "tc1",
                    }
                ],
            ),
            ToolMessage(content="a,b\n1,2", name="read_file", tool_call_id="tc1"),
            AIMessage(content="The answer is 3"),
        ]
        trace = _serialize_messages(msgs)
        assert len(trace) == 4
        assert trace[0]["role"] == "user"
        assert trace[1]["role"] == "assistant"
        assert trace[2]["role"] == "tool"
        assert trace[3]["role"] == "assistant"
        assert trace[3]["content"] == "The answer is 3"
```

- [ ] **Step 4: Run full test suite**

Run: `uv run pytest tests/ -v`
Expected: All tests PASS

- [ ] **Step 5: Run type check and lint**

Run: `uv run mypy src/statigent/baseline/react.py && uv run ruff check src/statigent/baseline/react.py tests/baseline/test_react.py`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/statigent/baseline/react.py tests/baseline/test_react.py
git commit -m "refactor: replace in-process PythonREPL with Docker sandbox in ReactBaselineAgent"
```

---

### Task 5: Create Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM python:3.12-slim

RUN pip install --no-cache-dir \
    pandas numpy scikit-learn scipy xgboost lightgbm \
    matplotlib seaborn torch torchvision

WORKDIR /workspace
```

- [ ] **Step 2: Build and test the image**

Run: `docker build -t statigent/ds-sandbox .`
Expected: Build succeeds

Run: `docker run --rm statigent/ds-sandbox python -c "import pandas, numpy, sklearn; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Dockerfile for DS sandbox image"
```

---

### Task 6: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add Docker to prerequisites**

Add after the "Install" subsection, before "API Keys":

```markdown
### Docker (Required for Agent Execution)

The baseline agent executes code inside Docker containers for isolation. Install Docker Desktop:

- **macOS**: https://docs.docker.com/desktop/install/mac-install/
- **Linux**: https://docs.docker.com/engine/install/

Then build the sandbox image:

```bash
docker build -t statigent/ds-sandbox .
```
```

- [ ] **Step 2: Add Baseline section**

Add after the "Evaluation" section:

```markdown
## Baseline Agents

### React Baseline

The React baseline agent (`ReactBaselineAgent`) uses langchain's `create_agent` with a Docker sandbox. Each evaluation task runs in an isolated container:

- **Tools**: `bash`, `python`, `read_file`, `write_file`, `list_dir`
- **Execution model**: One Docker container per task. Data directories are bind-mounted read-only; output files are extracted after task completion.
- **Network**: Disabled by default. Pass `sandbox_network=True` to enable.

```python
from statigent.baseline import ReactBaselineAgent

agent = ReactBaselineAgent(
    model_name="deepseek-v4-flash",
    sandbox_image="statigent/ds-sandbox",
    sandbox_network=False,
    sandbox_timeout=600,
)
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Docker prerequisite and React baseline section to README"
```

---

### Task 7: Clean up dependencies

**Files:**
- Modify: `pyproject.toml`

The `langchain-experimental` dependency is no longer needed after removing `PythonREPL`.

- [ ] **Step 1: Remove langchain-experimental from pyproject.toml**

Remove the line `"langchain-experimental>=0.4.1",` from the `dependencies` list in `pyproject.toml`.

- [ ] **Step 2: Verify nothing else uses langchain-experimental**

Run: `grep -r "langchain_experimental" src/ tests/`
Expected: No matches

- [ ] **Step 3: Sync and verify**

Run: `uv sync && uv run pytest tests/ -v`
Expected: All tests PASS, no import errors

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "chore: remove langchain-experimental dependency"
```
