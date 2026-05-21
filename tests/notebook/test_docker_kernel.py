from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from statigent.errors import StatigentSandboxError
from statigent.notebook import DockerNotebookKernel, NotebookContext


def start_or_skip_docker_kernel(
    kernel: DockerNotebookKernel,
    context: NotebookContext,
) -> None:
    try:
        kernel.start(context)
    except StatigentSandboxError as err:
        pytest.skip(f"Docker unavailable: {err}")


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

    cell = kernel.append_code_cell(
        "x = 1 + 1\nprint(x)",
        "compute",
        "Print the computed value",
    )
    result = kernel.execute_cell(cell.cell_id)
    context = kernel.get_code_context()

    assert cell.cell_id == "cell-1"
    assert result.stdout == "2\n"
    assert result.exit_code == 0
    assert result.purpose == "compute"
    assert context.cells[0].latest_result == result
    assert "statigent_notebook_driver.py" in sandbox.exec.call_args[0][0]


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_executes_replaced_cell_with_same_id(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    sandbox.exec.side_effect = [
        "",
        '{"stdout": "fixed\\n", "stderr": "", "exit_code": 0}',
    ]
    mock_sandbox_class.return_value = sandbox
    kernel = DockerNotebookKernel(image="image", network=False)
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))

    cell = kernel.append_code_cell(
        "print(missing)",
        "compute",
        "Print the computed value",
    )
    replaced = kernel.replace_code_cell(
        cell.cell_id,
        "print('fixed')",
        "compute after fix",
        "Print the fixed value",
    )
    result = kernel.execute_cell(replaced.cell_id)

    assert replaced.cell_id == cell.cell_id
    assert result.cell_id == cell.cell_id
    assert result.code == "print('fixed')"
    assert result.purpose == "compute after fix"
    assert result.stdout == "fixed\n"
    assert kernel.get_code_context().cells == [replaced]
    assert kernel.get_code_context().cells[0].latest_result == result


@patch("statigent.notebook.docker.DockerSandbox")
def test_docker_kernel_start_skips_when_docker_unavailable(
    mock_sandbox_class: MagicMock,
    tmp_path: Path,
) -> None:
    sandbox = MagicMock()
    sandbox.start.side_effect = StatigentSandboxError("Docker daemon is not running")
    mock_sandbox_class.return_value = sandbox
    kernel = DockerNotebookKernel(image="image", network=False)

    with pytest.raises(pytest.skip.Exception):
        start_or_skip_docker_kernel(
            kernel,
            NotebookContext(input_paths=[], work_dir=tmp_path / "work"),
        )


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
