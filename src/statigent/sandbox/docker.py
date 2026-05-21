"""Docker-based sandbox for isolated command execution."""

import atexit
import re
import subprocess
from pathlib import Path
from typing import Any

from loguru import logger

from statigent.errors import StatigentSandboxError

_DOCKER_ERROR_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"Error response from daemon:\s*"), "Error: "),
    (re.compile(r"[Cc]ontainer\s+[0-9a-f]{6,}"), "the environment"),
    (re.compile(r"is not running"), "is unavailable"),
    (re.compile(r"[Dd]ocker"), "system"),
]


def _sanitize_docker_errors(stderr: str) -> str:
    """Remove Docker-specific terms from error messages seen by the agent."""
    sanitized = stderr
    for pattern, replacement in _DOCKER_ERROR_PATTERNS:
        sanitized = pattern.sub(replacement, sanitized)
    return sanitized


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

    def _check_docker_available(self) -> None:
        """Verify Docker is installed and the daemon is running."""
        try:
            result = subprocess.run(
                ["docker", "info"],
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as err:
            raise StatigentSandboxError(
                "Docker is not installed or not in PATH"
            ) from err

        if result.returncode != 0:
            raise StatigentSandboxError(
                f"Docker daemon is not running: {result.stderr.strip()}"
            )

    def start(self, mounts: list[tuple[Path, str, bool]]) -> None:
        """Start a Docker container with the given mount specifications.

        Args:
            mounts: List of (host_path, container_path, read_only) tuples.

        Raises:
            StatigentSandboxError: If Docker is unavailable or container
                fails to start.
        """
        self._check_docker_available()

        cmd: list[str] = ["docker", "run", "-d"]

        for host_path, container_path, read_only in mounts:
            spec = f"{host_path}:{container_path}"
            if read_only:
                spec += ":ro"
            cmd.extend(["-v", spec])

        if not self._network:
            cmd.extend(["--network", "none"])

        cmd.extend(["-w", self._workdir])
        cmd.extend([self._image, "sleep", "infinity"])

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise StatigentSandboxError(
                f"Failed to start sandbox: {result.stderr.strip()}"
            )

        self._container_name = result.stdout.strip()
        atexit.register(self.stop)
        logger.info("Started container {}", self._container_name)

    def exec(self, cmd: str) -> str:
        """Execute a command inside the running container.

        Args:
            cmd: Shell command to execute.

        Returns:
            Command output string. On non-zero exit code the output is
            prefixed with ``Exit code: N\\n``. On timeout a descriptive
            error string is returned.

        Raises:
            StatigentSandboxError: If the container has not been started.
        """
        if not self._container_name:
            raise StatigentSandboxError("Container not started")

        docker_cmd = [
            "docker",
            "exec",
            self._container_name,
            "bash",
            "-c",
            cmd,
        ]

        try:
            result = subprocess.run(
                docker_cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                errors="replace",
            )
        except subprocess.TimeoutExpired:
            return f"Error: command timed out after {self._timeout} seconds"

        output = result.stdout
        if result.returncode != 0:
            raw_err = result.stderr
            sanitized = _sanitize_docker_errors(raw_err)
            output = f"Exit code: {result.returncode}\n{result.stdout}{sanitized}"

        return output

    def get_file(self, container_path: str, host_path: Path) -> None:
        """Copy a file from the container to the host filesystem.

        Args:
            container_path: Path inside the container.
            host_path: Destination path on the host.

        Raises:
            StatigentSandboxError: If the container is not started or the
                copy operation fails.
        """
        if not self._container_name:
            raise StatigentSandboxError("Container not started")

        result = subprocess.run(
            [
                "docker",
                "cp",
                f"{self._container_name}:{container_path}",
                str(host_path),
            ],
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise StatigentSandboxError(f"Failed to copy file: {result.stderr.strip()}")

    def stop(self) -> None:
        """Stop and remove the container. Idempotent — no-op if not running."""
        if not self._container_name:
            return

        name = self._container_name
        for docker_cmd in (["docker", "stop", name], ["docker", "rm", name]):
            try:
                subprocess.run(docker_cmd, capture_output=True, text=True)
            except Exception:
                logger.warning("Failed to run {} for container {}", docker_cmd, name)

        logger.info("Stopped container {}", name)
        self._container_name = ""

    def __enter__(self) -> "DockerSandbox":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop()
