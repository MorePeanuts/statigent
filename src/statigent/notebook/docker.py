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
from statigent.schemas import (
    ArtifactRef,
    NotebookCell,
    NotebookCellResult,
    NotebookCodeContext,
    NotebookState,
)

_ARTIFACT_SUFFIX_KINDS = {
    ".csv": "table",
    ".json": "data",
    ".md": "report",
    ".png": "chart",
    ".jpg": "chart",
    ".jpeg": "chart",
    ".svg": "chart",
}

# Python driver that lives inside the container. It decodes the base64
# cell payload, executes it in a persistent STATE dict, and emits JSON
# results on stdout. Pickleable values and module bindings are persisted
# so normal imports do not break later JSON output.
_DRIVER = r"""
import base64
import contextlib
import importlib
import io
import json
import os
import pickle
import sys
import traceback
from pathlib import Path
from types import ModuleType

STATE_PATH = Path(os.environ.get(
    "STATIGENT_NOTEBOOK_STATE_PATH",
    "/tmp/statigent_notebook_state.pkl",
))

def empty_state():
    return {"__name__": "__statigent_notebook__"}

def can_pickle(value):
    try:
        pickle.dumps(value)
    except Exception:
        return False
    return True

def load_state():
    if not STATE_PATH.exists():
        return empty_state()
    try:
        with STATE_PATH.open("rb") as f:
            payload = pickle.load(f)
    except Exception:
        return empty_state()
    if not isinstance(payload, dict):
        return empty_state()
    if "values" not in payload or "modules" not in payload:
        return payload
    state = empty_state()
    values = payload.get("values", {})
    if isinstance(values, dict):
        state.update(values)
    modules = payload.get("modules", {})
    if isinstance(modules, dict):
        for name, module_spec in modules.items():
            if not isinstance(name, str):
                continue
            module_names = []
            if isinstance(module_spec, str):
                module_names = [module_spec]
            elif isinstance(module_spec, list):
                module_names = [
                    item for item in module_spec if isinstance(item, str)
                ]
            if not module_names:
                continue
            for module_name in sorted(module_names, key=lambda value: value.count(".")):
                try:
                    importlib.import_module(module_name)
                except Exception:
                    pass
            try:
                state[name] = importlib.import_module(module_names[0])
            except Exception:
                pass
    return state

def save_state(state):
    values = {}
    modules = {}
    for name, value in state.items():
        if name == "__builtins__" or (
            name.startswith("__") and name.endswith("__")
        ):
            continue
        if isinstance(value, ModuleType):
            module_prefix = value.__name__
            related_modules = [
                module_name
                for module_name in sys.modules
                if module_name == module_prefix
                or module_name.startswith(module_prefix + ".")
            ]
            modules[name] = sorted(related_modules, key=lambda item: item.count("."))
            continue
        if can_pickle(value):
            values[name] = value
    payload = {"values": values, "modules": modules}
    tmp_path = STATE_PATH.with_suffix(STATE_PATH.suffix + ".tmp")
    with tmp_path.open("wb") as f:
        pickle.dump(payload, f)
    tmp_path.replace(STATE_PATH)

STATE = load_state()

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
        try:
            save_state(STATE)
        except Exception:
            pass
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
        self._cells: list[NotebookCell] = []
        self._state = NotebookState()

    def start(self, context: NotebookContext) -> None:
        self._context = context
        context.work_dir.mkdir(parents=True, exist_ok=True)
        (context.work_dir / "artifacts").mkdir(parents=True, exist_ok=True)
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
        mounts.append((context.work_dir.resolve(), "/workspace", False))
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

    def append_code_cell(
        self,
        code: str,
        purpose: str,
        expected_observation: str,
    ) -> NotebookCell:
        cell = NotebookCell(
            cell_id=f"cell-{len(self._cells) + 1}",
            code=code,
            purpose=purpose,
            expected_observation=expected_observation,
        )
        self._cells.append(cell)
        return cell

    def replace_code_cell(
        self,
        cell_id: str,
        code: str,
        purpose: str,
        expected_observation: str,
    ) -> NotebookCell:
        index, _cell = self._require_cell(cell_id)
        cell = NotebookCell(
            cell_id=cell_id,
            code=code,
            purpose=purpose,
            expected_observation=expected_observation,
        )
        self._cells[index] = cell
        return cell

    def execute_cell(self, cell_id: str) -> NotebookCellResult:
        sandbox = self._require_sandbox()
        _index, cell = self._require_cell(cell_id)
        encoded = base64.b64encode(cell.code.encode()).decode()
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
            cell_id=cell.cell_id,
            code=cell.code,
            purpose=cell.purpose,
            stdout=str(payload.get("stdout", "")),
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=duration_ms,
            artifacts=self._refresh_artifacts(),
            error_summary=stderr[:500] if exit_code else "",
        )
        cell.latest_result = result
        self._state.executed_cells.append(result)
        return result

    def get_code_context(self) -> NotebookCodeContext:
        return NotebookCodeContext(cells=list(self._cells))

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
        self._refresh_artifacts()
        return self._state.artifacts

    def snapshot(self) -> NotebookState:
        return self._state

    def _require_sandbox(self) -> DockerSandbox:
        if self._sandbox is None:
            raise StatigentNotebookError("Docker notebook kernel has not been started")
        return self._sandbox

    def _require_cell(self, cell_id: str) -> tuple[int, NotebookCell]:
        for index, cell in enumerate(self._cells):
            if cell.cell_id == cell_id:
                return index, cell
        raise StatigentNotebookError(f"Unknown notebook cell: {cell_id}")

    def _refresh_artifacts(self) -> list[ArtifactRef]:
        if self._context is None:
            return self._state.artifacts
        artifact_dir = self._context.work_dir / "artifacts"
        if not artifact_dir.exists():
            return self._state.artifacts
        known_paths = {artifact.path.resolve() for artifact in self._state.artifacts}
        for path in sorted(item for item in artifact_dir.rglob("*") if item.is_file()):
            resolved = path.resolve()
            if resolved in known_paths:
                continue
            relative_name = path.relative_to(artifact_dir).as_posix()
            self._state.artifacts.append(
                ArtifactRef(
                    name=relative_name,
                    path=path,
                    kind=_ARTIFACT_SUFFIX_KINDS.get(path.suffix.casefold(), "file"),
                    description=f"Generated artifact: {relative_name}",
                )
            )
            known_paths.add(resolved)
        return self._state.artifacts
