from pathlib import Path

from statigent.notebook import FakeNotebookKernel, NotebookContext


def test_fake_kernel_executes_queued_results(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="rows=2\n", exit_code=0)
    kernel.start(NotebookContext(input_paths=[tmp_path], work_dir=tmp_path / "work"))

    result = kernel.execute_cell("print('rows=2')", "count rows")

    assert result.stdout == "rows=2\n"
    assert result.purpose == "count rows"
    assert kernel.snapshot().executed_cells[0].code == "print('rows=2')"


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
