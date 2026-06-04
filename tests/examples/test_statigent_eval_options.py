import importlib
import inspect
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_example(module_name: str) -> object:
    path = ROOT / "examples" / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dabench_eval_exposes_enable_reviewer_option() -> None:
    eval_dabench = load_example("eval_dabench")
    signature = inspect.signature(eval_dabench.main)

    assert "enable_reviewer" in signature.parameters
    assert signature.parameters["enable_reviewer"].default is False
    assert "enable_reviewer=enable_reviewer" in inspect.getsource(
        eval_dabench.main
    )


def test_dsbench_da_eval_exposes_enable_reviewer_option() -> None:
    eval_dsbench_da = load_example("eval_dsbench_da")
    signature = inspect.signature(eval_dsbench_da.main)

    assert "enable_reviewer" in signature.parameters
    assert signature.parameters["enable_reviewer"].default is False
    assert "enable_reviewer=enable_reviewer" in inspect.getsource(
        eval_dsbench_da.main
    )
