"""Tests for DockerSandbox lifecycle management."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from statigent.errors import StatigentSandboxError
from statigent.sandbox.docker import DockerSandbox, _sanitize_docker_errors


class TestDockerSandboxInit:
    """Test DockerSandbox initialization with default and custom params."""

    def test_init_default_params(self) -> None:
        sandbox = DockerSandbox()
        assert sandbox._image == "statigent/ds-sandbox"
        assert sandbox._network is False
        assert sandbox._workdir == "/workspace"
        assert sandbox._timeout == 600
        assert sandbox._container_name == ""

    def test_init_custom_params(self) -> None:
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
        assert sandbox._container_name == ""


class TestDockerSandboxStart:
    """Test DockerSandbox.start() with mount args, network flag, errors, atexit."""

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_start_basic_mounts(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.side_effect = [
            MagicMock(returncode=0),
            MagicMock(returncode=0, stdout="abc123container\n"),
        ]
        sandbox = DockerSandbox()
        mounts = [
            (Path("/host/data"), "/container/data", True),
            (Path("/host/output"), "/container/output", False),
        ]
        sandbox.start(mounts)

        assert sandbox._container_name == "abc123container"
        mock_atexit.assert_called_once_with(sandbox.stop)

        docker_run_call = mock_run.call_args_list[1]
        cmd = docker_run_call[0][0]
        assert "docker" in cmd
        assert "run" in cmd
        assert "-d" in cmd
        assert "-v" in cmd
        assert "/host/data:/container/data:ro" in cmd
        assert "/host/output:/container/output" in cmd
        assert "-w" in cmd
        assert "/workspace" in cmd
        assert "statigent/ds-sandbox" in cmd

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_start_with_network_disabled(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.side_effect = [
            MagicMock(returncode=0),
            MagicMock(returncode=0, stdout="netcontainer\n"),
        ]
        sandbox = DockerSandbox(network=False)
        sandbox.start([])

        docker_run_call = mock_run.call_args_list[1]
        cmd = docker_run_call[0][0]
        assert "--network" in cmd
        assert "none" in cmd

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_start_with_network_enabled(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.side_effect = [
            MagicMock(returncode=0),
            MagicMock(returncode=0, stdout="netcontainer\n"),
        ]
        sandbox = DockerSandbox(network=True)
        sandbox.start([])

        docker_run_call = mock_run.call_args_list[1]
        cmd = docker_run_call[0][0]
        assert "--network" not in cmd

    @patch(
        "statigent.sandbox.docker.subprocess.run",
        side_effect=FileNotFoundError("docker not found"),
    )
    def test_start_docker_not_installed(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="Docker is not installed"):
            sandbox.start([])

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_start_docker_daemon_not_running(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(
            returncode=1, stderr="Cannot connect to the Docker daemon"
        )
        sandbox = DockerSandbox()
        with pytest.raises(
            StatigentSandboxError, match="Docker daemon is not running"
        ):
            sandbox.start([])

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_start_container_start_fails(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.side_effect = [
            MagicMock(returncode=0),
            MagicMock(returncode=1, stderr="image not found"),
        ]
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="Failed to start sandbox"):
            sandbox.start([])

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_start_registers_atexit(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.side_effect = [
            MagicMock(returncode=0),
            MagicMock(returncode=0, stdout="atexitcontainer\n"),
        ]
        sandbox = DockerSandbox()
        sandbox.start([])

        mock_atexit.assert_called_once_with(sandbox.stop)

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_start_read_only_mount_spec(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.side_effect = [
            MagicMock(returncode=0),
            MagicMock(returncode=0, stdout="rocontainer\n"),
        ]
        sandbox = DockerSandbox()
        sandbox.start([(Path("/host/data"), "/container/data", True)])

        docker_run_call = mock_run.call_args_list[1]
        cmd = docker_run_call[0][0]
        assert "/host/data:/container/data:ro" in cmd

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_start_read_write_mount_spec(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.side_effect = [
            MagicMock(returncode=0),
            MagicMock(returncode=0, stdout="rwcontainer\n"),
        ]
        sandbox = DockerSandbox()
        sandbox.start([(Path("/host/output"), "/container/output", False)])

        docker_run_call = mock_run.call_args_list[1]
        cmd = docker_run_call[0][0]
        assert "/host/output:/container/output" in cmd
        rw_entry = "/host/output:/container/output:ro"
        assert rw_entry not in cmd


class TestDockerSandboxExec:
    """Test DockerSandbox.exec() for command execution, errors, timeout."""

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_exec_success(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(returncode=0, stdout="hello world\n")

        result = sandbox.exec("echo hello world")
        assert result == "hello world\n"

        cmd = mock_run.call_args[0][0]
        assert "docker" in cmd
        assert "exec" in cmd
        assert "testcontainer" in cmd
        assert "bash" in cmd
        assert "-c" in cmd

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_exec_nonzero_exit_code(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(
            returncode=1, stdout="some error output", stderr="error details"
        )

        result = sandbox.exec("bad_command")
        assert result.startswith("Exit code: 1\n")
        assert "some error output" in result

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_exec_stderr_on_error(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(
            returncode=2, stdout="", stderr="stderr content"
        )

        result = sandbox.exec("failing_cmd")
        assert "Exit code: 2" in result
        assert "stderr content" in result

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_exec_timeout(self, mock_run: MagicMock) -> None:
        import subprocess

        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.side_effect = subprocess.TimeoutExpired(
            cmd="docker exec", timeout=600
        )

        result = sandbox.exec("slow_command")
        assert "timed out" in result.lower()

    def test_exec_no_container_raises(self) -> None:
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="Container not started"):
            sandbox.exec("echo hello")

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_exec_uses_timeout(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox(timeout=120)
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(returncode=0, stdout="done")

        sandbox.exec("echo done")
        assert mock_run.call_args[1]["timeout"] == 120


class TestDockerSandboxGetFile:
    """Test DockerSandbox.get_file() for copy commands and failures."""

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_get_file_success(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(returncode=0)

        sandbox.get_file("/container/path/file.txt", Path("/host/path/file.txt"))

        cmd = mock_run.call_args[0][0]
        assert "docker" in cmd
        assert "cp" in cmd
        assert "testcontainer:/container/path/file.txt" in cmd
        assert "/host/path/file.txt" in cmd

    def test_get_file_no_container_raises(self) -> None:
        sandbox = DockerSandbox()
        with pytest.raises(StatigentSandboxError, match="Container not started"):
            sandbox.get_file("/some/path", Path("/host/path"))

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_get_file_copy_fails(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(
            returncode=1, stderr="No such file"
        )

        with pytest.raises(StatigentSandboxError, match="Failed to copy file"):
            sandbox.get_file("/missing/path", Path("/host/path"))


class TestDockerSandboxStop:
    """Test DockerSandbox.stop() for stop+rm, idempotency, noop."""

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_stop_running_container(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(returncode=0)

        sandbox.stop()

        assert mock_run.call_count == 2
        stop_cmd = mock_run.call_args_list[0][0][0]
        rm_cmd = mock_run.call_args_list[1][0][0]
        assert "stop" in stop_cmd
        assert "testcontainer" in stop_cmd
        assert "rm" in rm_cmd
        assert "testcontainer" in rm_cmd
        assert sandbox._container_name == ""

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_stop_idempotent(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(returncode=0)

        sandbox.stop()
        sandbox.stop()

        assert mock_run.call_count == 2
        assert sandbox._container_name == ""

    def test_stop_never_started_noop(self) -> None:
        sandbox = DockerSandbox()
        sandbox.stop()
        assert sandbox._container_name == ""

    @patch("statigent.sandbox.docker.subprocess.run")
    def test_stop_docker_failure_logged_not_raised(self, mock_run: MagicMock) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        mock_run.return_value = MagicMock(
            returncode=1, stderr="container not found"
        )

        sandbox.stop()
        assert sandbox._container_name == ""


class TestDockerSandboxContextManager:
    """Test DockerSandbox as context manager calls stop on exit."""

    @patch.object(DockerSandbox, "stop")
    def test_context_manager_calls_stop_on_exit(
        self, mock_stop: MagicMock
    ) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        with sandbox:
            pass
        mock_stop.assert_called_once()

    @patch.object(DockerSandbox, "stop")
    def test_context_manager_returns_self(
        self, mock_stop: MagicMock
    ) -> None:
        sandbox = DockerSandbox()
        with sandbox as ctx:
            assert ctx is sandbox

    @patch.object(DockerSandbox, "stop")
    def test_context_manager_calls_stop_on_exception(
        self, mock_stop: MagicMock
    ) -> None:
        sandbox = DockerSandbox()
        sandbox._container_name = "testcontainer"
        with pytest.raises(ValueError), sandbox:
            raise ValueError("test error")
        mock_stop.assert_called_once()


class TestSanitizeDockerErrors:
    """Test that Docker-specific terms are removed from error messages."""

    def test_removes_daemon_error_prefix(self) -> None:
        result = _sanitize_docker_errors(
            "Error response from daemon: something failed"
        )
        assert "daemon" not in result
        assert "Error: something failed" == result

    def test_removes_container_id(self) -> None:
        result = _sanitize_docker_errors(
            "Container 9cca72ff6c0e is not running"
        )
        assert "9cca72ff" not in result
        assert "the environment" in result

    def test_removes_docker_keyword(self) -> None:
        result = _sanitize_docker_errors("docker: command not found")
        assert "docker" not in result.lower()
        assert "system" in result

    def test_replaces_not_running(self) -> None:
        result = _sanitize_docker_errors("is not running")
        assert "is unavailable" in result
        assert "not running" not in result

    def test_preserves_non_docker_errors(self) -> None:
        result = _sanitize_docker_errors("permission denied")
        assert result == "permission denied"


class TestDockerSandboxStartSleepInfinity:
    """Test that start() includes 'sleep infinity' to keep container alive."""

    @patch("statigent.sandbox.docker.subprocess.run")
    @patch("statigent.sandbox.docker.atexit.register")
    def test_includes_sleep_infinity(
        self, mock_atexit: MagicMock, mock_run: MagicMock
    ) -> None:
        mock_run.return_value = MagicMock(stdout="abc123\n", returncode=0)
        sandbox = DockerSandbox()
        sandbox.start([])
        cmd = mock_run.call_args[0][0]
        assert cmd[-2:] == ["sleep", "infinity"]
