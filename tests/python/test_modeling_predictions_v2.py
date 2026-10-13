import copy
import json

import pytest
from statigent_modeling.metrics_v2 import InvalidPredictions
from statigent_modeling.predictions_v2 import validate_files, validate_predictions
from statigent_modeling.protocol_v2 import prediction_columns_v2
from test_modeling_scoring_v2 import LIMITS, file_ref, protocol_for


def test_external_ranked_predictions_without_model_or_private_labels(tmp_path):
    protocol = protocol_for("top3-hit-ds-v1")
    classes = protocol["targets"][0]["classes"]
    columns = prediction_columns_v2(protocol, False)
    rows = [["b", json.dumps(classes[:2])], ["a", json.dumps(classes[:3])]]
    result = validate_files(
        {
            "version": 2,
            "request_id": "external",
            "protocol": protocol,
            "expected": file_ref(
                tmp_path, "ids.csv", [protocol["id_column"]], [["a"], ["b"]]
            ),
            "predictions": file_ref(tmp_path, "external.csv", columns, rows),
            "limits": LIMITS,
        }
    )
    assert result["rows"] == 2
    assert sorted(p.name for p in tmp_path.iterdir()) == ["external.csv", "ids.csv"]
    for ranked in [[], [classes[0], classes[0]], ["unknown"], classes * 2]:
        with pytest.raises(InvalidPredictions):
            validate_predictions(protocol, columns, [["a", json.dumps(ranked)]], ["a"])


def test_multilabel_target_order_shape_and_independent_sums():
    protocol = protocol_for("mean-target-auc-v1")
    targets = protocol["targets"]
    columns = prediction_columns_v2(protocol)
    row = ["a"]
    for target in targets:
        row.extend([target["classes"][1], "0.1", "0.9"])
    result = validate_predictions(protocol, columns, [row], ["a"])
    assert sum(r["probabilities"][0][1] for r in result) > 1
    swapped = [columns[0], *columns[4:7], *columns[1:4]]
    for bad_columns, bad_rows in [
        (swapped, [row]),
        (columns[:-1], [row[:-1]]),
        (columns, [row[:-1]]),
        (columns, [row, row]),
        (columns, []),
    ]:
        with pytest.raises(InvalidPredictions):
            validate_predictions(protocol, bad_columns, bad_rows, ["a"])
    for index, value in [
        (1, "unknown"),
        (2, "-0.1"),
        (3, "1.1"),
        (3, "nan"),
        (3, "0.1"),
    ]:
        changed = copy.copy(row)
        changed[index] = value
        with pytest.raises(InvalidPredictions):
            validate_predictions(protocol, columns, [changed], ["a"])


def test_ranked_ties_and_probability_mismatch():
    protocol = protocol_for("top3-hit-ds-v1")
    classes = protocol["targets"][0]["classes"]
    columns = prediction_columns_v2(protocol)
    row = ["a", json.dumps(classes[:3]), *[str(1 / len(classes))] * len(classes)]
    validate_predictions(protocol, columns, [row], ["a"])
    row[1] = json.dumps(classes[:3][::-1])
    with pytest.raises(InvalidPredictions, match="disagree"):
        validate_predictions(protocol, columns, [row], ["a"])
