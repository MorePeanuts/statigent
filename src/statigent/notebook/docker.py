"""Docker-backed notebook kernel with incremental state.

Each cell runs inside a Docker sandbox. State (variables, imports) is
pickled to disk after every successful cell so subsequent cells inherit
the accumulated namespace.

Security: all code is base64-encoded before shell transport; file paths
are quoted with shlex.quote() to prevent command injection.
"""

import base64
import json
import shlex
import time
from pathlib import Path

from statigent.errors import StatigentNotebookError
from statigent.notebook.base import FileReadResult, NotebookContext
from statigent.sandbox.docker import DockerSandbox
from statigent.schemas import ArtifactRef, NotebookCellResult, NotebookState

# Python driver that lives inside the container. It decodes the base64
# cell payload, executes it in a persistent STATE dict, and emits JSON
# results on stdout. State is serialized via pickle so it survives
# across container exec calls.
_DRIVER = r"""
import base64
import contextlib
import io
import json
import pickle
import sys
import traceback
from pathlib import Path

STATE_PATH = Path("/tmp/statigent_notebook_state.pkl")
if STATE_PATH.exists():
    with STATE_PATH.open("rb") as f:
        STATE = pickle.load(f)
else:
    STATE = {"__name__": "__statigent_notebook__"}

def run_cell(encoded):
    code = base64.b64decode(encoded.encode()).decode()
    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = 0
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            exec(code, STATE, STATE)
        except Exception:
            exit_code = 1
            traceback.print_exc(file=stderr)
    if exit_code == 0:
        with STATE_PATH.open("wb") as f:
            pickle.dump(STATE, f)
    print(json.dumps({
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "exit_code": exit_code,
    }))
"""


class DockerNotebookKernel:
    """Notebook kernel that executes cells in an isolated Docker sandbox.

    Each cell runs via `sandbox.exec()` with state persisted between cells
    using pickle. Input files are bind-mounted read-only into the container.
    """

    def __init__(
        self,
        *,
        image: str = "statigent/ds-sandbox",
        network: bool = False,
    ) -> None:
        self.image = image
        self.network = network
        self._sandbox: DockerSandbox | None = None
        self._context: NotebookContext | None = None
        self._state = NotebookState()

    def start(self, context: NotebookContext) -> None:
        self._context = context
        context.work_dir.mkdir(parents=True, exist_ok=True)
        self._sandbox = DockerSandbox(
            image=self.image,
            network=self.network,
            timeout=context.timeout_seconds,
        )
        dirs = {
            path.resolve() if path.is_dir() else path.resolve().parent
            for path in context.input_paths
        }
        mounts = [(path, str(path), True) for path in sorted(dirs)]
        self._sandbox.start(mounts)
        encoded_driver = base64.b64encode(_DRIVER.encode()).decode()
        self._sandbox.exec(
            f"echo {shlex.quote(encoded_driver)} | base64 -d > "
            "/tmp/statigent_notebook_driver.py"
        )

    def close(self) -> None:
        if self._sandbox is not None:
            self._sandbox.stop()
        self._sandbox = None
        self._context = None

    def execute_cell(self, code: str, purpose: str) -> NotebookCellResult:
        sandbox = self._require_sandbox()
        encoded = base64.b64encode(code.encode()).decode()
        command = (
            "python - <<'PY'\n"
            "import importlib.util\n"
            "spec = importlib.util.spec_from_file_location("
            "'driver', '/tmp/statigent_notebook_driver.py')\n"
            "driver = importlib.util.module_from_spec(spec)\n"
            "if spec.loader is None:\n"
            "    raise RuntimeError('driver loader missing')\n"
            "spec.loader.exec_module(driver)\n"
            f"driver.run_cell({encoded!r})\n"
            "PY"
        )
        start = time.perf_counter()
        raw = sandbox.exec(command)
        duration_ms = int((time.perf_counter() - start) * 1000)
        try:
            payload = json.loads(raw.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError) as err:
            msg = f"Invalid notebook execution output: {raw}"
            raise StatigentNotebookError(msg) from err

        stderr = str(payload.get("stderr", ""))
        exit_code = int(payload.get("exit_code", 1))
        result = NotebookCellResult(
            cell_id=f"cell-{len(self._state.executed_cells) + 1}",
            code=code,
            purpose=purpose,
            stdout=str(payload.get("stdout", "")),
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=duration_ms,
            artifacts=[],
            error_summary=stderr[:500] if exit_code else "",
        )
        self._state.executed_cells.append(result)
        return result

    def read_file(
        self,
        path: Path,
        *,
        max_bytes: int = 100_000,
        max_rows: int = 0,
    ) -> FileReadResult:
        sandbox = self._require_sandbox()
        safe_path = shlex.quote(str(path))
        if max_rows > 0:
            raw = sandbox.exec(f"head -n {max_rows} {safe_path}")
        else:
            raw = sandbox.exec(f"head -c {max_bytes + 1} {safe_path}")
        truncated = len(raw.encode()) > max_bytes
        return FileReadResult(path=path, content=raw[:max_bytes], truncated=truncated)

    def write_artifact(self, name: str, content: str, kind: str) -> ArtifactRef:
        # TODO: also write artifact into the container's /workspace so that
        # subsequent cells can access generated files.
        if self._context is None:
            raise StatigentNotebookError("Docker notebook kernel has not been started")
        path = self._context.work_dir / "artifacts" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        artifact = ArtifactRef(name=name, path=path, kind=kind)
        self._state.artifacts.append(artifact)
        return artifact

    def list_inputs(self) -> list[Path]:
        if self._context is None:
            return []
        return self._context.input_paths

    def list_artifacts(self) -> list[ArtifactRef]:
        return self._state.artifacts

    def snapshot(self) -> NotebookState:
        return self._state

    def _require_sandbox(self) -> DockerSandbox:
        if self._sandbox is None:
            raise StatigentNotebookError("Docker notebook kernel has not been started")
        return self._sandbox
