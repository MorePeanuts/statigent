from pathlib import Path

from statigent.errors import StatigentNotebookError
from statigent.notebook.base import FileReadResult, NotebookContext
from statigent.schemas import ArtifactRef, NotebookCellResult, NotebookState


class FakeNotebookKernel:
    """In-process notebook kernel for testing.

    execute_cell pops from a pre-configured queue of (stdout, stderr,
    exit_code) tuples, so tests control exactly what each cell returns.
    read_file and write_artifact operate on the real local filesystem.
    """

    def __init__(self) -> None:
        self._context: NotebookContext | None = None
        self._queued: list[tuple[str, str, int]] = []
        self._state = NotebookState()

    def queue_result(
        self,
        stdout: str = "",
        stderr: str = "",
        exit_code: int = 0,
    ) -> None:
        self._queued.append((stdout, stderr, exit_code))

    def start(self, context: NotebookContext) -> None:
        self._context = context
        context.work_dir.mkdir(parents=True, exist_ok=True)

    def close(self) -> None:
        self._context = None

    def execute_cell(self, code: str, purpose: str) -> NotebookCellResult:
        if self._context is None:
            raise StatigentNotebookError("Fake notebook kernel has not been started")
        stdout, stderr, exit_code = self._queued.pop(0) if self._queued else ("", "", 0)
        result = NotebookCellResult(
            cell_id=f"cell-{len(self._state.executed_cells) + 1}",
            code=code,
            purpose=purpose,
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=0,
            artifacts=[],
            error_summary=stderr if exit_code else "",
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
        content = path.read_text()
        if max_rows > 0:
            content = "\n".join(content.splitlines()[:max_rows])
        encoded = content.encode()
        truncated = len(encoded) > max_bytes
        if truncated:
            content = encoded[:max_bytes].decode(errors="replace")
        return FileReadResult(path=path, content=content, truncated=truncated)

    def write_artifact(self, name: str, content: str, kind: str) -> ArtifactRef:
        if self._context is None:
            raise StatigentNotebookError("Fake notebook kernel has not been started")
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
