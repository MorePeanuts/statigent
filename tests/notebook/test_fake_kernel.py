from pathlib import Path

import pytest

from statigent.errors import StatigentNotebookError
from statigent.notebook import FakeNotebookKernel, NotebookContext


def test_fake_kernel_runs_cell_lifecycle_with_replacement(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stderr="NameError: missing\n", exit_code=1)
    kernel.queue_result(stdout="rows=2\n", exit_code=0)
    kernel.start(NotebookContext(input_paths=[tmp_path], work_dir=tmp_path / "work"))

    cell = kernel.append_code_cell(
        "print(missing)",
        "count rows",
        "Print the number of rows",
    )
    failed = kernel.execute_cell(cell.cell_id)
    replaced = kernel.replace_code_cell(
        cell.cell_id,
        "print('rows=2')",
        "count rows after fixing variable",
        "Print the number of rows",
    )
    result = kernel.execute_cell(replaced.cell_id)
    context = kernel.get_code_context()

    assert cell.cell_id == "cell-1"
    assert failed.cell_id == "cell-1"
    assert failed.exit_code == 1
    assert result.stdout == "rows=2\n"
    assert result.purpose == "count rows after fixing variable"
    assert kernel.snapshot().executed_cells == [failed, result]
    assert context.cells == [replaced]
    assert context.cells[0].latest_result == result


def test_fake_kernel_rejects_unknown_cell_ids(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[tmp_path], work_dir=tmp_path / "work"))

    with pytest.raises(StatigentNotebookError, match="Unknown notebook cell"):
        kernel.replace_code_cell("missing", "print(1)", "purpose", "expected")

    with pytest.raises(StatigentNotebookError, match="Unknown notebook cell"):
        kernel.execute_cell("missing")


def test_fake_kernel_records_artifacts(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[tmp_path], work_dir=tmp_path / "work"))

    artifact = kernel.write_artifact("summary.md", "content", "report")

    assert artifact.name == "summary.md"
    assert artifact in kernel.list_artifacts()


def test_fake_kernel_list_inputs(tmp_path: Path) -> None:
    data = tmp_path / "sales.csv"
    data.write_text("x\n1\n")
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[data], work_dir=tmp_path / "work"))

    assert kernel.list_inputs() == [data]
