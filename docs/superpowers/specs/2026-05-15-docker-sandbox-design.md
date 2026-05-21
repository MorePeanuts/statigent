# Docker Sandbox for ReactBaselineAgent — Design Spec

## Problem

The current `ReactBaselineAgent` runs all code in-process via `langchain_experimental.utilities.PythonREPL` with only regex-based safety checks. This has critical shortcomings:

1. **No real isolation** — regex checks are trivially bypassed (e.g., `getattr(os, 'system')('rm -rf /')`)
2. **Limited tooling** — only `python_repl` and `read_file`; no bash, write, ls, etc.
3. **File output is fragile** — modeling tasks require the agent to write `submission.csv` at a host path, but there's no enforced mechanism
4. **No resource limits** — no timeout, memory cap, or network control

Data modeling tasks (MLEBench, DSBench-DM) need richer tools (bash, file write) and must produce output files. A proper sandbox is required.

## Decision Summary

| Decision | Choice |
|----------|--------|
| Sandbox type | Docker container |
| Scope | Both analysis and modeling tasks |
| Agent framework | Keep langchain `create_agent` |
| Network access | Disabled by default, configurable |
| Tool exposure | Separate typed tools (no `sandbox_` prefix) |
| Base image | Pre-built DS image |
| Container lifecycle | One container per task (Approach A) |
| Data access | Docker bind mounts (read-only), not copy |
| DSBench-DM evaluation | Separate task, not included here |

## Architecture

### DockerSandbox class

New class at `src/statigent/sandbox/docker.py`:

```python
class DockerSandbox:
    def __init__(
        self,
        image: str = "statigent/ds-sandbox",
        network: bool = False,
        workdir: str = "/workspace",
        timeout: int = 600,
    ) -> None: ...

    def start(self, mounts: list[tuple[Path, str, bool]]) -> None:
        """Start container with bind mounts.

        Each mount is (host_path, container_path, read_only).
        Runs: docker run -d -v host:container:ro ... --network none
        """

    def exec(self, cmd: str) -> str:
        """Run command in container, return stdout+stderr.
        Enforces timeout. Returns error string on timeout.
        """

    def get_file(self, container_path: str, host_path: Path) -> None:
        """docker cp container:container_path host_path"""

    def stop(self) -> None:
        """docker stop + docker rm"""

    def __enter__(self) -> DockerSandbox: ...
    def __exit__(self, *exc) -> None: ...
```

Key details:
- Container name includes UUID to avoid collisions
- `atexit` handler as backup cleanup
- Raises clear error if Docker daemon is unavailable
- `exec()` uses `docker exec <container> bash -c <cmd>` with timeout via `subprocess`
- Workdir `/workspace` is the container's writable layer (not bind-mounted)

### Sandbox tools

The agent registers these tools (no `sandbox_` prefix — the Docker layer is hidden from the agent):

| Tool | Signature | Description |
|------|-----------|-------------|
| `bash` | `(command: str) -> str` | Run any bash command |
| `python` | `(code: str) -> str` | Execute Python code via `python -c` |
| `read_file` | `(file_path: str, max_lines: int = 0) -> str` | Read file contents |
| `write_file` | `(file_path: str, content: str) -> str` | Write content to file |
| `list_dir` | `(path: str = "/workspace") -> str` | List directory contents |

Implementation:
- Each tool holds a reference to the current `DockerSandbox` instance
- `bash` → `sandbox.exec(command)`
- `python` → `sandbox.exec(f'python -c {shlex.quote(code)}')`
- `read_file` → `sandbox.exec(f'head -n {max_lines} {shlex.quote(file_path)}' if max_lines else f'cat {shlex.quote(file_path)}')`
- `write_file` → `sandbox.exec(f"cat > {shlex.quote(file_path)} << 'STATIGENT_EOF'\n{content}\nSTATIGENT_EOF")`
- `list_dir` → `sandbox.exec(f'ls -la {shlex.quote(path)}')`
- All outputs use `_truncate_content()` for long responses
- No regex-based safety checks — Docker provides real isolation

### ReactBaselineAgent changes

```python
class ReactBaselineAgent:
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
        # No longer create self.agent here — it's created per-run with sandbox tools

    def _create_agent(self, sandbox: DockerSandbox) -> Agent:
        """Create a langchain agent with tools bound to the given sandbox."""
        tools = [
            bash_tool(sandbox),
            python_tool(sandbox),
            read_file_tool(sandbox),
            write_file_tool(sandbox),
            list_dir_tool(sandbox),
        ]
        llm = get_model(self.model_name)
        return create_agent(llm, tools, system_prompt=_SYSTEM_PROMPT)

    def run_analysis_for_eval(self, prompt, *, files=None, task_instructions=""):
        with DockerSandbox(self.sandbox_image, self.sandbox_network, timeout=self.sandbox_timeout) as sandbox:
            mounts = [(f, f"/workspace/{f.name}", True) for f in files or []]
            sandbox.start(mounts)
            agent = self._create_agent(sandbox)
            # ... construct prompt with /workspace/ paths ...
            result = retry_on_conn_error(agent.invoke)(...)
            return result["messages"][-1].content, _serialize_messages(result["messages"])

    def run_modeling_for_eval(self, prompt, *, train_path, test_path, sample_submission_path, task_instructions=""):
        with DockerSandbox(self.sandbox_image, self.sandbox_network, timeout=self.sandbox_timeout) as sandbox:
            data_dir = train_path.parent
            mounts = [(data_dir, "/workspace/data", True)]
            sandbox.start(mounts)
            agent = self._create_agent(sandbox)
            # ... construct prompt with /workspace/data/ paths ...
            result = retry_on_conn_error(agent.invoke)(...)
            # Extract output
            output_path = Path(tempfile.mkdtemp()) / "submission.csv"
            sandbox.get_file("/workspace/submission.csv", output_path)
            return output_path, _serialize_messages(result["messages"])
```

### System prompt

```
You are a data science assistant with access to the following tools:
1. read_file — Read the contents of a file
2. write_file — Write content to a file
3. python — Execute Python code (pandas, numpy, scikit-learn, etc.)
4. bash — Run shell commands
5. list_dir — List directory contents

Your working directory is /workspace. All data files are located here.

General guidelines:
- Use read_file with max_lines=5 first to preview file structure before loading with Python
- Write and execute Python code to perform computations
- For modeling tasks, generate predictions and save them as CSV using python or bash
- Print results clearly so they can be captured
```

### Benchmark adapter impact

No changes to `DataScienceAgent` protocol or any adapter code. The sandbox is entirely internal to `ReactBaselineAgent`.

**MLEBench note:** Currently both `train_path` and `test_path` point to `competition.public_dir`. The sandbox will mount this entire directory at `/workspace/data:ro`, and the prompt will reference `/workspace/data/` paths.

### Docker image

A `Dockerfile` at the project root:

```dockerfile
FROM python:3.12-slim

RUN pip install --no-cache-dir \
    pandas numpy scikit-learn scipy xgboost lightgbm \
    matplotlib seaborn torch torchvision

WORKDIR /workspace
```

Built and tagged as `statigent/ds-sandbox`. Published to Docker Hub or built locally before eval runs.

### Error handling

- **Docker unavailable**: Raise `StatigentError` at sandbox init with install instructions
- **Command timeout**: `sandbox.exec()` returns a timeout error string (not an exception), so the agent can react and try a different approach
- **Container cleanup**: Context manager + `atexit` handler ensures `docker stop/rm` always runs
- **Missing output file**: If `submission.csv` doesn't exist after modeling, `get_file` returns a clear error; agent logs a warning and returns a nonexistent path (same as current behavior)
- **Docker exec failure**: Non-zero exit codes are returned as part of the output string, visible to the agent

### File structure

New/modified files:

```
src/statigent/
├── sandbox/
│   ├── __init__.py          # exports DockerSandbox
│   └── docker.py            # DockerSandbox class
├── baseline/
│   └── react.py             # Updated ReactBaselineAgent with sandbox tools
Dockerfile                    # DS sandbox image
baseline/react/
├── eval_dabench.py          # No changes
└── eval_dsbench_da.py       # No changes
README.md                     # Updated
```

### README updates

The README must be updated to document:

1. **Prerequisites section** — add Docker as a required dependency; include instructions for building the sandbox image (`docker build -t statigent/ds-sandbox .`)
2. **Baseline section** — add a subsection briefly introducing the React baseline agent: its architecture (langchain `create_agent` + Docker sandbox), available tools (`bash`, `python`, `read_file`, `write_file`, `list_dir`), and execution model (per-task container, bind mounts for data)

### Testing strategy

- Unit tests for `DockerSandbox` with a mock Docker CLI (or `pytest.mark.integration` with real Docker)
- Unit tests for tool functions with a mock `DockerSandbox`
- Integration test: run a simple analysis task through the sandbox agent
- Integration test: run a simple modeling task and verify CSV output
- Skip Docker-dependent tests if Docker is unavailable
