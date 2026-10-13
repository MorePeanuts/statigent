import json
from pathlib import Path

import pytest
from statigent_benchmarks.ds_catalog import MAPPINGS, inspect_csv

ROOT = Path(__file__).resolve().parents[2]


def test_mapping_covers_candidates_and_keeps_actual_metric_identity():
    catalog = json.loads(
        (ROOT / "benchmarks/metadata/modeling-task-catalog.json").read_text()
    )
    tasks = {
        t["task_id"]: t
        for t in catalog["tasks"]
        if t["benchmark"] == "dsbench-modeling"
    }
    assert set(MAPPINGS) == set(tasks)
    expected = {
        "s3e23": "roc-auc-v1",
        "s3e20": "rmse-v1",
        "s3e13": "top3-hit-ds-v1",
        "s3e19": "smape-ds-v1",
        "s3e5": "quadratic-kappa-ds10-v1",
    }
    for suffix, metric in expected.items():
        task = tasks[f"playground-series-{suffix}"]
        assert task["protocol"]["metric"]["id"] == metric
        if suffix != "s3e5":
            assert task["issues"]
    multi = tasks["playground-series-s3e18"]["protocol"]
    assert multi["targets"] == ["EC1", "EC2"]
    assert multi["excluded_columns"] == ["EC3", "EC4", "EC5", "EC6"]
    assert not set(multi["targets"] + multi["excluded_columns"]) & set(
        multi["feature_columns"]
    )
    bike = tasks["bike-sharing-demand"]["protocol"]
    assert "datetime" in bike["feature_columns"]
    assert bike["excluded_columns"] == ["casual", "registered"]
    for task in tasks.values():
        protocol = task["protocol"]
        assert protocol["metric"]["id"] == MAPPINGS[task["task_id"]]["metric"]
        assert protocol["scorer"]["access"] == "evaluator"


def test_csv_identity_handles_strings_missing_ids_and_duplicate_ids(tmp_path):
    path = tmp_path / "input.csv"
    path.write_text('id,x\n01,"line\nbreak"\n1,NA\n')
    result = inspect_csv(path, "id")
    assert result == {"columns": ["id", "x"], "rows": 2, "valid_id": True}
    assert not inspect_csv(path, "absent")["valid_id"]
    path.write_text("id,x\na,1\na,2\n")
    assert not inspect_csv(path, "id")["valid_id"]
    path.write_text("id,x\na,1,2\n")
    with pytest.raises(ValueError, match="Ragged"):
        inspect_csv(path, "id")
