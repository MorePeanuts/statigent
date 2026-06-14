import json
from collections.abc import Callable
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType


def _load_script() -> ModuleType:
    script_path = Path(__file__).parents[2] / "tools" / "backfill_average_steps.py"
    spec = spec_from_file_location("backfill_average_steps", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_backfill_run_removes_obsolete_step_metrics(tmp_path: Path) -> None:
    backfill_run = _load_script()._backfill_run
    assert isinstance(backfill_run, Callable)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    meta_path = run_dir / "meta.json"
    meta_path.write_text(
        json.dumps(
            {
                "agent_name": "statigent",
                "total_steps": 100,
                "average_steps": 4.0,
                "completed_tasks": 25,
            }
        )
    )

    assert backfill_run(run_dir) is True

    meta = json.loads(meta_path.read_text())
    assert meta == {"agent_name": "statigent", "completed_tasks": 25}
