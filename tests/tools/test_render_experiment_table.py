import csv
import json
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType


def _load_script() -> ModuleType:
    script_path = Path(__file__).parents[2] / "tools" / "render_experiment_table.py"
    spec = spec_from_file_location("render_experiment_table", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_dataset(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "benchmark": "dabench",
                "rows": [
                    {
                        "agent": "Statigent",
                        "llm": "DeepSeek-v4-Pro",
                        "metrics": {"abq": 0.9027, "psaq": 0.9298, "uasq": 0.9342},
                        "inference": {
                            "total_steps": 2983,
                            "average_steps": 11.607003891050583,
                            "total_code_lines": 5463,
                            "code_error_rate": 0.002149326970381435,
                            "input_tokens": 5047708,
                            "output_tokens": 344332,
                        },
                        "metadata": {
                            "date": "2026-06-12",
                            "source": "evaluations",
                            "link": (
                                "evaluations/"
                                "dabench-statigent-ds4-pro-20260612T233947"
                            ),
                        },
                    }
                ],
            }
        )
    )


def test_format_markdown_table_renders_percentages_and_counts(tmp_path: Path) -> None:
    module = _load_script()
    dataset_path = tmp_path / "dabench.json"
    _write_dataset(dataset_path)

    table = module.render_table(dataset_path, output_format="markdown")

    assert "| Agent | LLM(s) used | ABQ | PSQA | UASQ |" in table
    assert "| Statigent | DeepSeek-v4-Pro | 90.27 | 92.98 | 93.42 |" in table
    assert "0.21%" in table
    assert "5,047,708" in table


def test_format_csv_table_writes_header_and_row(tmp_path: Path) -> None:
    module = _load_script()
    dataset_path = tmp_path / "dabench.json"
    _write_dataset(dataset_path)

    output_path = tmp_path / "table.csv"
    module.render_table(dataset_path, output_format="csv", output_path=output_path)

    rows = list(csv.DictReader(output_path.read_text().splitlines()))
    assert rows == [
        {
            "Agent": "Statigent",
            "LLM(s) used": "DeepSeek-v4-Pro",
            "ABQ": "90.27",
            "PSQA": "92.98",
            "UASQ": "93.42",
            "Total steps": "2,983",
            "Average steps": "11.61",
            "Total code lines": "5,463",
            "Code error rate": "0.21%",
            "Input tokens": "5,047,708",
            "Output tokens": "344,332",
            "Date": "2026-06-12",
            "Source": "evaluations",
            "Link": "evaluations/dabench-statigent-ds4-pro-20260612T233947",
        }
    ]
