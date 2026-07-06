"""Render experiment JSON files as Markdown or CSV tables.

Usage:
    uv run python tools/render_experiment_table.py experiment/dabench_results.json
    uv run python tools/render_experiment_table.py experiment/dabench_results.json \
        --format csv --output table.csv
"""

import argparse
import csv
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import cast

type JSONValue = (
    None | bool | int | float | str | list["JSONValue"] | dict[str, "JSONValue"]
)

_HEADERS = [
    "Agent",
    "LLM(s) used",
    "ABQ",
    "PSQA",
    "UASQ",
    "Total steps",
    "Average steps",
    "Total code lines",
    "Code error rate",
    "Input tokens",
    "Output tokens",
    "Date",
    "Source",
    "Link",
]


def _mapping(value: JSONValue) -> Mapping[str, JSONValue]:
    if not isinstance(value, dict):
        return {}
    return value


def _rows(dataset_path: Path) -> list[Mapping[str, JSONValue]]:
    value = cast("JSONValue", json.loads(dataset_path.read_text()))
    dataset = _mapping(value)
    rows = dataset.get("rows")
    if not isinstance(rows, list):
        return []
    return [_mapping(row) for row in rows]


def _number(value: JSONValue) -> float | int | None:
    if type(value) in {int, float}:
        return cast("float | int", value)
    return None


def _format_decimal(value: JSONValue, digits: int = 2) -> str:
    number = _number(value)
    if number is None:
        return "-"
    return f"{number:.{digits}f}"


def _format_percent_fraction(value: JSONValue) -> str:
    number = _number(value)
    if number is None:
        return "-"
    return f"{number * 100:.2f}"


def _format_error_rate(value: JSONValue) -> str:
    formatted = _format_percent_fraction(value)
    return "-" if formatted == "-" else f"{formatted}%"


def _format_count(value: JSONValue) -> str:
    number = _number(value)
    if number is None:
        return "-"
    return f"{round(number):,}"


def _format_text(value: JSONValue) -> str:
    return value if isinstance(value, str) and value else "-"


def _table_row(row: Mapping[str, JSONValue]) -> dict[str, str]:
    metrics = _mapping(row.get("metrics"))
    inference = _mapping(row.get("inference"))
    metadata = _mapping(row.get("metadata"))
    return {
        "Agent": _format_text(row.get("agent")),
        "LLM(s) used": _format_text(row.get("llm")),
        "ABQ": _format_percent_fraction(metrics.get("abq")),
        "PSQA": _format_percent_fraction(metrics.get("psaq")),
        "UASQ": _format_percent_fraction(metrics.get("uasq")),
        "Total steps": _format_count(inference.get("total_steps")),
        "Average steps": _format_decimal(inference.get("average_steps")),
        "Total code lines": _format_count(inference.get("total_code_lines")),
        "Code error rate": _format_error_rate(inference.get("code_error_rate")),
        "Input tokens": _format_count(inference.get("input_tokens")),
        "Output tokens": _format_count(inference.get("output_tokens")),
        "Date": _format_text(metadata.get("date")),
        "Source": _format_text(metadata.get("source")),
        "Link": _format_text(metadata.get("link")),
    }


def _markdown(rows: Sequence[dict[str, str]]) -> str:
    lines = [
        "| " + " | ".join(_HEADERS) + " |",
        "| " + " | ".join("---" for _ in _HEADERS) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(row[header] for header in _HEADERS) + " |")
    return "\n".join(lines) + "\n"


def _write_csv(rows: Sequence[dict[str, str]], output_path: Path) -> None:
    with output_path.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=_HEADERS)
        writer.writeheader()
        writer.writerows(rows)


def render_table(
    dataset_path: Path,
    *,
    output_format: str = "markdown",
    output_path: Path | None = None,
) -> str:
    """Render an experiment dataset as a Markdown string or CSV file."""
    table_rows = [_table_row(row) for row in _rows(dataset_path)]
    if output_format == "csv":
        if output_path is None:
            raise ValueError("CSV output requires output_path")
        _write_csv(table_rows, output_path)
        return ""
    if output_format != "markdown":
        raise ValueError(f"Unsupported output format: {output_format}")
    table = _markdown(table_rows)
    if output_path is not None:
        output_path.write_text(table)
    return table


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Path to an experiment JSON file.")
    parser.add_argument(
        "--format",
        choices=["markdown", "csv"],
        default="markdown",
        help="Output table format.",
    )
    parser.add_argument("--output", type=Path, help="Optional output path.")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    table = render_table(
        args.dataset,
        output_format=args.format,
        output_path=args.output,
    )
    if args.output is None and table:
        print(table, end="")


if __name__ == "__main__":
    main()
