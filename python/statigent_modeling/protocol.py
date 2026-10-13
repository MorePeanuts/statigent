"""Frozen tabular semantics shared by the runner and the trusted scorer."""

import hashlib
import json

import numpy as np


def validate_protocol(value, id_column):
    expected_keys = {
        "version",
        "kind",
        "metric",
        "direction",
        "output",
        "classes",
        "positive_class",
        "prediction",
        "scoring_version",
        "protocol_sha256",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("Invalid protocol fields")
    matrix = {
        ("regression", "rmse"): ("minimize", "numeric"),
        ("binary", "accuracy"): ("maximize", "label"),
        ("binary", "roc_auc"): ("maximize", "probabilities"),
        ("binary", "log_loss"): ("minimize", "probabilities"),
        ("multiclass", "accuracy"): ("maximize", "label"),
        ("multiclass", "log_loss"): ("minimize", "probabilities"),
    }
    key = (value["kind"], value["metric"])
    if key not in matrix or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Unsupported task protocol")
    direction, output = matrix[key]
    classes = value["classes"]
    if not isinstance(classes, list) or any(
        not isinstance(c, str) or not c.strip() for c in classes
    ):
        raise ValueError("Invalid classes")
    if classes != sorted(set(classes), key=lambda c: c.encode("utf-8")):
        raise ValueError("Invalid class order")
    kind = value["kind"]
    if (
        (kind == "regression" and classes)
        or (kind == "binary" and len(classes) != 2)
        or (kind == "multiclass" and len(classes) < 3)
    ):
        raise ValueError("Task class count mismatch")
    positive = value["positive_class"]
    if (kind == "binary" and positive not in classes) or (
        kind != "binary" and positive is not None
    ):
        raise ValueError("Invalid positive class")
    used = {id_column}

    def name(base):
        while base in used:
            base += "_"
        used.add(base)
        return base

    prediction = {
        "column": name("prediction"),
        "probability_columns": [name(f"probability_{i}") for i in range(len(classes))]
        if output == "probabilities"
        else [],
    }
    canonical = {
        "version": 1,
        "kind": kind,
        "metric": value["metric"],
        "direction": direction,
        "output": output,
        "classes": classes,
        "positive_class": positive,
        "prediction": prediction,
        "scoring_version": "tabular-metrics-v1",
    }
    digest = hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    canonical["protocol_sha256"] = digest
    if value != canonical:
        raise ValueError("Protocol identity mismatch")
    return canonical


def probabilities(value, rows, classes):
    p = np.asarray(value, dtype=np.float64)
    if p.shape != (rows, classes) or not np.isfinite(p).all():
        raise ValueError("Invalid probability shape/values")
    if (p < 0).any() or (p > 1).any() or (np.abs(p.sum(axis=1) - 1) > 1e-6).any():
        raise ValueError("Invalid probability range/sum")
    return p


def class_indices(values, count):
    a = np.asarray(values)
    if a.ndim != 1 or a.dtype.kind not in "iu" or (a < 0).any() or (a >= count).any():
        raise ValueError("Invalid encoded classes")
    return a.astype(np.int64)
