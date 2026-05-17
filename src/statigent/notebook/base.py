from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, Field

from statigent.schemas import ArtifactRef, NotebookCellResult, NotebookState


class NotebookContext(BaseModel):
    input_paths: list[Path]
    work_dir: Path
    timeout_seconds: int = Field(default=600, ge=1)


class FileReadResult(BaseModel):
    path: Path
    content: str
    truncated: bool = False


class NotebookKernel(Protocol):
    def start(self, context: NotebookContext) -> None: ...

    def close(self) -> None: ...

    def execute_cell(self, code: str, purpose: str) -> NotebookCellResult: ...

    def read_file(
        self,
        path: Path,
        *,
        max_bytes: int = 100_000,
        max_rows: int = 0,
    ) -> FileReadResult: ...

    def write_artifact(self, name: str, content: str, kind: str) -> ArtifactRef: ...

    def list_inputs(self) -> list[Path]: ...

    def list_artifacts(self) -> list[ArtifactRef]: ...

    def snapshot(self) -> NotebookState: ...
