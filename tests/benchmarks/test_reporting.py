import json
from pathlib import Path

from rich.table import Table

from statigent.benchmarks.base import EvalResult
from statigent.benchmarks.reporting import build_evaluation_table, find_latest_run_dir


def test_build_evaluation_table_uses_meta_and_score_without_details(
    tmp_path: Path,
) -> None:
    (tmp_path / "evaluation").mkdir()
    (tmp_path / "meta.json").write_text(
        json.dumps(
            {
                "agent_name": "react",
                "model_name": "deepseek-v4-flash",
                "benchmark_name": "dabench",
                "input_tokens": 12,
                "output_tokens": 7,
                "duration_seconds": 3.5,
            }
        )
    )
    (tmp_path / "evaluation" / "scores.json").write_text(
        json.dumps(
            {
                "score": {"ABQ": 1.0, "PSAQ": 0.75, "UASQ": 0.8},
                "agent_name": "react",
                "model_name": "deepseek-v4-flash",
                "benchmark_name": "dabench",
                "total_tasks": 2,
                "others": {"total_competitions": 1},
                "details": {"per_question": [{"id": 1}]},
            }
        )
    )

    table = build_evaluation_table(tmp_path)

    assert isinstance(table, Table)
    labels, values = _table_cells(table)
    assert labels == [
        "input_tokens",
        "output_tokens",
        "duration_seconds",
        "score",
        "total_tasks",
        "others",
        "agent_name",
        "model_name",
        "benchmark_name",
    ]
    assert values[0:6] == [
        "12",
        "7",
        "3.5",
        '{"ABQ": 1.0, "PSAQ": 0.75, "UASQ": 0.8}',
        "2",
        '{"total_competitions": 1}',
    ]
    assert "details" not in labels


def test_build_evaluation_table_falls_back_to_eval_result() -> None:
    result = EvalResult(
        score={"TLAcc": 0.5, "CLAcc": 0.25},
        details={"per_question": []},
        agent_name="agent",
        model_name="model",
        benchmark_name="dsbench-da",
        total_tasks=3,
        others={"total_competitions": 1},
    )

    table = build_evaluation_table(None, result=result)

    labels, values = _table_cells(table)
    assert labels == [
        "score",
        "total_tasks",
        "others",
        "agent_name",
        "model_name",
        "benchmark_name",
    ]
    assert values[0] == '{"TLAcc": 0.5, "CLAcc": 0.25}'


def test_find_latest_run_dir_matches_result_context(tmp_path: Path) -> None:
    older = tmp_path / "dabench-agent-model-20260101T000000"
    newer = tmp_path / "dabench-agent-model-20260102T000000"
    unrelated = tmp_path / "dsbench-agent-model-20260103T000000"
    for run_dir in (older, newer, unrelated):
        run_dir.mkdir()
    (older / "meta.json").write_text(
        json.dumps(
            {
                "agent_name": "agent",
                "model_name": "model",
                "benchmark_name": "dabench",
                "timestamp": "20260101T000000",
            }
        )
    )
    (newer / "meta.json").write_text(
        json.dumps(
            {
                "agent_name": "agent",
                "model_name": "model",
                "benchmark_name": "dabench",
                "timestamp": "20260102T000000",
            }
        )
    )
    (unrelated / "meta.json").write_text(
        json.dumps(
            {
                "agent_name": "agent",
                "model_name": "model",
                "benchmark_name": "dsbench-da",
                "timestamp": "20260103T000000",
            }
        )
    )
    result = EvalResult(
        score={"ABQ": 1.0},
        details={},
        agent_name="agent",
        model_name="model",
        benchmark_name="dabench",
    )

    assert find_latest_run_dir(tmp_path, result) == newer


def _table_cells(table: Table) -> tuple[list[str], list[str]]:
    labels = list(table.columns[0]._cells)
    values = list(table.columns[1]._cells)
    return labels, values
