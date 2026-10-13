import json

import pytest
from statigent_modeling.comparison_v2 import TOLERANCE, compare_files
from statigent_modeling.protocol_v2 import prediction_columns_v2
from statigent_modeling.scoring_v2 import score_v2
from test_modeling_scoring_v2 import LIMITS, file_ref, protocol_for


def request(tmp_path, metric, reference, actual, optional=True):
    p = protocol_for(metric)
    return {
        "version": 2,
        "request_id": "comparison",
        "protocol": p,
        "limits": LIMITS,
        "tolerance": TOLERANCE,
        "expected": file_ref(tmp_path, "ids.csv", [p["id_column"]], [["a"], ["b"]]),
        "reference": file_ref(
            tmp_path, "reference.csv", prediction_columns_v2(p, optional), reference
        ),
        "actual": file_ref(
            tmp_path, "actual.csv", prediction_columns_v2(p, optional), actual
        ),
    }


def score(tmp_path, req, ref):
    p = req["protocol"]
    labels = file_ref(
        tmp_path,
        ref + "-labels.csv",
        [p["id_column"], *[t["name"] for t in p["targets"]]],
        [
            [name, *[t["classes"][i] for t in p["targets"]]]
            for i, name in enumerate(["a", "b"])
        ],
    )
    return score_v2(
        {
            "version": 2,
            "request_id": "score",
            "protocol": p,
            "evaluation_id": "a" * 64,
            "partition": "test",
            "labels": labels,
            "predictions": req[ref],
            "limits": LIMITS,
        }
    )["value"]


def test_multilabel_one_probability_target_changed_same_aggregate_is_not_reproduction(
    tmp_path,
):
    p = protocol_for("mean-target-auc-v1")
    original = [
        [name, *[v for t in p["targets"] for v in [t["classes"][0], "0.9", "0.1"]]]
        for name in ["a", "b"]
    ]
    changed = [r[:-2] + ["0.8", "0.2"] for r in original]
    req = request(tmp_path, "mean-target-auc-v1", original, changed)
    assert score(tmp_path, req, "reference") == score(tmp_path, req, "actual")
    result = compare_files(req)
    assert not result["matched"]
    assert result["differences"] == [p["targets"][-1]["name"] + "/probabilities"]


def test_ranked_order_changes_fail_even_when_hit_score_is_equal(tmp_path):
    p = protocol_for("top3-hit-ds-v1")
    classes = p["targets"][0]["classes"]
    original = [[name, json.dumps(classes[:3])] for name in ["a", "b"]]
    changed = [[name, json.dumps(classes[:3][::-1])] for name in ["b", "a"]]
    req = request(tmp_path, "top3-hit-ds-v1", original, changed, False)
    assert score(tmp_path, req, "reference") == score(tmp_path, req, "actual")
    assert compare_files(req)["differences"] == [p["targets"][0]["name"] + "/ranked"]


def test_numeric_tolerance_and_id_reordering_are_explicit_and_frozen(tmp_path):
    req = request(
        tmp_path, "mae-v1", [["a", "1"], ["b", "2"]], [["b", "2.0000001"], ["a", "1.0"]]
    )
    assert compare_files(req)["matched"]
    req["tolerance"] = {"atol": 1, "rtol": 1}
    with pytest.raises(ValueError, match="tolerance"):
        compare_files(req)
    req["tolerance"] = TOLERANCE
    req["actual"]["sha256"] = "b" * 64
    with pytest.raises(ValueError, match="identity"):
        compare_files(req)
