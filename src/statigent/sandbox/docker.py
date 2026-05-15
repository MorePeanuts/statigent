"""Docker-based sandbox for isolated command execution."""

from pathlib import Path
from typing import Any


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
    def exec(self, cmd: str) -> str: ...  # type: ignore[empty-body]
    def get_file(self, container_path: str, host_path: Path) -> None: ...
    def stop(self) -> None: ...
    def __enter__(self) -> "DockerSandbox": ...  # type: ignore[empty-body]
    def __exit__(self, *exc: Any) -> None: ...
