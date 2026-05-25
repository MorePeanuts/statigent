from collections.abc import Callable
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any


def load_panel_title() -> Callable[[dict[str, Any], int], str]:
    script_path = Path(__file__).parents[2] / "tools" / "trace_statigent.py"
    spec = spec_from_file_location("trace_statigent", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    panel_title = module._panel_title
    assert callable(panel_title)
    return panel_title


def test_panel_title_includes_cell_id_for_code_related_events() -> None:
    title = load_panel_title()(
        {
            "agent": "coder",
            "session": 1,
            "name": "append_code_cell",
            "role": "assistant",
            "metadata": {"cell_id": "cell-1"},
        },
        3,
    )

    assert title == "#3 coder s1 - append_code_cell cell=cell-1 (assistant)"


def test_panel_title_omits_cell_id_for_unrelated_events() -> None:
    title = load_panel_title()(
        {
            "agent": "inspector",
            "session": 1,
            "name": "plan",
            "role": "assistant",
            "metadata": {"cell_id": "cell-1"},
        },
        1,
    )

    assert title == "#1 inspector s1 - plan (assistant)"
