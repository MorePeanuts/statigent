import csv
import hashlib
import math

import numpy as np
import pytest
from sklearn.metrics import (
    accuracy_score,
    log_loss,
    roc_auc_score,
    root_mean_squared_error,
)
from statigent_modeling.scoring import InvalidPredictions, score
from test_modeling_runner import protocol


def request(tmp_path, p, labels, probabilities=None, predictions=None):
    def table(name, columns, rows):
        path = tmp_path / name
        with path.open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(columns)
            writer.writerows(rows)
        data = path.read_bytes()
        return {
            "path": str(path),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }

    if predictions is None:
        predictions = [p["classes"][i] for i in np.argmax(probabilities, axis=1)]
    rows = [
        [str(i), value, *(probabilities[i] if probabilities is not None else [])]
        for i, value in enumerate(predictions)
    ]
    return {
        "version": 1,
        "request_id": "test",
        "protocol": p,
        "id_column": "id",
        "target": "target",
        "labels": table(
            "labels.csv", ["id", "target"], [[str(i), y] for i, y in enumerate(labels)]
        ),
        "predictions": table(
            "predictions.csv",
            ["id", "prediction", *p["prediction"]["probability_columns"]],
            rows[::-1],
        ),
    }


def test_auc_explicit_first_positive_and_ties(tmp_path):
    p = protocol()
    y = ["01", "1", "01", "1"]
    prob = np.array([[0.8, 0.2], [0.8, 0.2], [0.4, 0.6], [0.1, 0.9]])
    r = request(tmp_path, p, y, prob)
    before = (tmp_path / "predictions.csv").read_bytes()
    assert score(r)["value"] == 0.625
    assert score(r)["value"] == roc_auc_score([1, 0, 1, 0], prob[:, 0])
    assert (tmp_path / "predictions.csv").read_bytes() == before
    with pytest.raises(InvalidPredictions, match="both classes"):
        score(request(tmp_path, p, ["01"] * 4, prob))


@pytest.mark.parametrize("classes", [["01", "1"], ["NA", "blue", "红色"]])
def test_accuracy_and_logloss(tmp_path, classes):
    n = len(classes)
    kind = "binary" if n == 2 else "multiclass"
    positive = classes[0] if n == 2 else None
    p = protocol(kind, "accuracy", classes, positive)
    pred = classes[::-1]
    assert score(request(tmp_path, p, classes, predictions=pred))[
        "value"
    ] == accuracy_score(classes, pred)
    p = protocol(kind, "log_loss", classes, positive)
    prob = np.full((n, n), 0.2 / (n - 1))
    np.fill_diagonal(prob, 0.8)
    assert score(request(tmp_path, p, classes, prob))["value"] == pytest.approx(
        -math.log(0.8)
    )
    assert score(request(tmp_path, p, classes, prob))["value"] == pytest.approx(
        log_loss(classes, prob, labels=classes)
    )
    zeros = np.roll(np.eye(n), 1, axis=1)
    assert math.isfinite(score(request(tmp_path, p, classes, zeros))["value"])
    assert score(request(tmp_path, p, classes, zeros))["value"] == pytest.approx(
        -math.log(1e-15 / (1 + (n - 2) * 1e-15))
    )
    with pytest.raises(InvalidPredictions, match="Unknown"):
        score(request(tmp_path, p, ["unknown"] * n, prob))


def test_regression_and_protocol_failure(tmp_path):
    import json

    p = {
        "version": 1,
        "kind": "regression",
        "metric": "rmse",
        "direction": "minimize",
        "output": "numeric",
        "classes": [],
        "positive_class": None,
        "prediction": {"column": "prediction", "probability_columns": []},
        "scoring_version": "tabular-metrics-v1",
    }
    p["protocol_sha256"] = hashlib.sha256(
        json.dumps(p, separators=(",", ":")).encode()
    ).hexdigest()
    r = request(tmp_path, p, [1, 3], predictions=[2, 5])
    assert score(r)["value"] == root_mean_squared_error([1, 3], [2, 5])
    r["predictions"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="identity"):
        score(r)
    r["predictions"]["path"] = str(tmp_path / "missing.csv")
    with pytest.raises(ValueError, match="file"):
        score(r)
