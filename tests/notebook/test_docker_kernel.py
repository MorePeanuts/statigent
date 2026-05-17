from pathlib import Path
from unittest.mock import MagicMock, patch

from statigent.notebook import DockerNotebookKernel, NotebookContext


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_starts_sandbox_with_mounts(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    mock_sandbox_class.return_value = sandbox
    data = tmp_path / "sales.csv"
    data.write_text("x\n1\n")
    kernel = DockerNotebookKernel(image="image", network=False)

    kernel.start(NotebookContext(input_paths=[data], work_dir=tmp_path / "work"))

    sandbox.start.assert_called_once()
    mounts = sandbox.start.call_args[0][0]
    assert any(mount[0] == data.parent for mount in mounts)


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_execute_cell_wraps_incremental_driver(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    sandbox.exec.return_value = '{"stdout": "2\\n", "stderr": "", "exit_code": 0}'
    mock_sandbox_class.return_value = sandbox
    kernel = DockerNotebookKernel(image="image", network=False)
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))

    result = kernel.execute_cell("x = 1 + 1\nprint(x)", "compute")

    assert result.stdout == "2\n"
    assert result.exit_code == 0
    assert "statigent_notebook_driver.py" in sandbox.exec.call_args[0][0]


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_close_stops_sandbox(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    mock_sandbox_class.return_value = sandbox
    kernel = DockerNotebookKernel(image="image", network=False)
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))

    kernel.close()

    sandbox.stop.assert_called_once()
