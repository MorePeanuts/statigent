import csv
import hashlib
import json
from pathlib import Path

import pytest
from statigent_modeling.metrics_v2 import InvalidPredictions, MetricUndefined
from statigent_modeling.protocol_v2 import prediction_columns_v2
from statigent_modeling.scoring_v2 import score_v2

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[1] / "fixtures/modeling-protocol-v2.json"
    ).read_text()
)
LIMITS = {
    "max_file_bytes": 32 * 1024 * 1024,
    "max_rows": 1000000,
    "max_columns": 4096,
    "max_field_bytes": 65536,
    "max_memory_bytes": 512 * 1024 * 1024,
}


def file_ref(tmp_path, name, columns, rows):
    path = tmp_path / name
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(columns)
        writer.writerows(rows)
    return {
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def request(
    tmp_path,
    protocol,
    labels,
    predictions,
    partition="search-validation",
    optional=True,
):
    return {
        "version": 2,
        "request_id": "test",
        "protocol": protocol,
        "evaluation_id": "a" * 64,
        "partition": partition,
        "labels": file_ref(
            tmp_path,
            "labels.csv",
            [protocol["id_column"], *[t["name"] for t in protocol["targets"]]],
            labels,
        ),
        "predictions": file_ref(
            tmp_path,
            "predictions.csv",
            prediction_columns_v2(protocol, optional),
            predictions,
        ),
        "limits": LIMITS,
    }


def protocol_for(metric):
    return next(
        v["protocol"]
        for v in FIXTURES["valid"]
        if v["protocol"]["metric"]["id"] == metric
    )


def test_every_partition_uses_one_metric_and_keeps_evaluation_identity(tmp_path):
    protocol = protocol_for("mae-v1")
    for partition in [
        "search-validation",
        "search-training",
        "confirmation-validation",
        "confirmation-training",
        "test",
    ]:
        result = score_v2(
            request(
                tmp_path,
                protocol,
                [["a", 10], ["b", 20]],
                [["b", 17], ["a", 11]],
                partition,
            )
        )
        assert result["value"] == 2
        assert result["partition"] == partition
        assert result["evaluation_id"] == "a" * 64
        assert (
            result["metric_definition_sha256"]
            == protocol["metric"]["definition_sha256"]
        )


def test_id_alignment_duplicate_missing_and_gini_ties(tmp_path):
    protocol = protocol_for("normalized-gini-ds-v1")
    labels = [[str(i), label] for i, label in enumerate(["01", "1", "01", "1"])]
    predictions = [[str(i), "01", 0.5, 0.5] for i in range(4)]
    assert (
        score_v2(request(tmp_path, protocol, labels, predictions[::-1]))["value"] == 0.5
    )
    for invalid in [
        predictions[:-1],
        [predictions[0]] * 4,
        [*predictions, ["extra", "01", 0.5, 0.5]],
    ]:
        with pytest.raises(InvalidPredictions, match="membership"):
            score_v2(request(tmp_path, protocol, labels, invalid))


def test_multilabel_aggregate_and_undefined_diagnostics(tmp_path):
    protocol = protocol_for("mean-target-auc-v1")
    labels = [["a", "01", "1"], ["b", "1", "01"]]
    predictions = [
        ["a", "01", 0.8, 0.2, "1", 0.1, 0.9],
        ["b", "1", 0.1, 0.9, "01", 0.8, 0.2],
    ]
    result = score_v2(request(tmp_path, protocol, labels, predictions))
    assert result["value"] == 1 and len(result["components"]) == 2
    labels[0][2] = "01"
    with pytest.raises(MetricUndefined) as error:
        score_v2(request(tmp_path, protocol, labels, predictions))
    assert error.value.diagnostics[1]["value"] is None


def test_external_ranked_file_needs_no_probabilities_or_model(tmp_path):
    protocol = protocol_for("top3-hit-ds-v1")
    request_data = request(
        tmp_path,
        protocol,
        [["a", "三"]],
        [["a", json.dumps(["eight", "five", "三"], ensure_ascii=False)]],
        optional=False,
    )
    assert score_v2(request_data)["value"] == 1
    request_data["partition"] = "unknown"
    with pytest.raises(ValueError, match="identity"):
        score_v2(request_data)


def test_tampered_files_and_explicit_limits_are_rejected(tmp_path):
    protocol = protocol_for("rmse-v1")
    data = request(tmp_path, protocol, [["a", 1]], [["a", 2]])
    data["limits"] = {**LIMITS, "max_file_bytes": 1}
    with pytest.raises(ValueError, match="limit"):
        score_v2(data)
    data["limits"] = LIMITS
    (tmp_path / "predictions.csv").write_text("changed")
    with pytest.raises(InvalidPredictions, match="identity"):
        score_v2(data)
