"""Trusted data-only scorer; never imports candidates or deserializes models."""

import csv
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

from statigent_modeling.metrics_v2 import InvalidPredictions as InvalidPredictionsV2
from statigent_modeling.protocol import probabilities, validate_protocol
from statigent_modeling.scoring_v2 import score_v2


class InvalidPredictions(ValueError):
    pass


def read_table(ref):
    path = Path(ref["path"])
    if path.is_symlink() or not path.is_file() or path.resolve() != path:
        raise ValueError("Invalid scoring file")
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Scoring file too large")
    data = path.read_bytes()
    if (
        len(data) > 32 * 1024 * 1024
        or len(data) != ref["bytes"]
        or hashlib.sha256(data).hexdigest() != ref["sha256"]
    ):
        raise ValueError("Scoring file identity mismatch")
    lines = list(csv.reader(data.decode("utf-8-sig").splitlines(keepends=True)))
    if (
        not lines
        or not lines[0]
        or len(set(lines[0])) != len(lines[0])
        or any(len(r) != len(lines[0]) for r in lines[1:])
    ):
        raise ValueError("Invalid scoring CSV")
    return lines[0], lines[1:]


def score(request):
    if (
        set(request)
        != {
            "version",
            "request_id",
            "protocol",
            "id_column",
            "target",
            "labels",
            "predictions",
        }
        or request["version"] != 1
        or not isinstance(request["request_id"], str)
    ):
        raise ValueError("Invalid scoring request")
    id_column, target = request["id_column"], request["target"]
    p = validate_protocol(request["protocol"], id_column)
    lc, labels = read_table(request["labels"])
    pc, rows = read_table(request["predictions"])
    if lc != [id_column, target] or pc != [
        id_column,
        p["prediction"]["column"],
        *p["prediction"]["probability_columns"],
    ]:
        raise InvalidPredictions("Invalid score columns")
    actual = {r[0]: r[1:] for r in rows}
    ids = [r[0] for r in labels]
    if (
        not ids
        or any(not i.strip() for i in ids)
        or len(set(ids)) != len(ids)
        or len(actual) != len(rows)
        or set(actual) != set(ids)
    ):
        raise InvalidPredictions("Score membership mismatch")
    values = [actual[i] for i in ids]
    y = [r[1] for r in labels]
    if p["kind"] == "regression":
        a, b = (
            np.asarray([r[0] for r in values], dtype=np.float64),
            np.asarray(y, dtype=np.float64),
        )
        if not np.isfinite(a).all() or not np.isfinite(b).all():
            raise InvalidPredictions("Non-finite score values")
        result = float(np.sqrt(np.mean((a - b) ** 2)))
    else:
        classes = p["classes"]
        if any(v not in classes for v in y) or any(r[0] not in classes for r in values):
            raise InvalidPredictions("Unknown score class")
        if p["metric"] == "accuracy":
            result = sum(r[0] == t for r, t in zip(values, y, strict=True)) / len(y)
        else:
            try:
                prob = probabilities([r[1:] for r in values], len(y), len(classes))
            except ValueError as e:
                raise InvalidPredictions(str(e)) from e
            derived = [classes[i] for i in np.argmax(prob, axis=1)]
            if derived != [r[0] for r in values]:
                raise InvalidPredictions("Probability label mismatch")
            if p["metric"] == "roc_auc":
                binary = [int(t == p["positive_class"]) for t in y]
                if len(set(binary)) != 2:
                    raise InvalidPredictions("ROC AUC requires both classes")
                result = float(
                    roc_auc_score(binary, prob[:, classes.index(p["positive_class"])])
                )
            else:
                normalized = prob / prob.sum(axis=1, keepdims=True)
                clipped = np.clip(normalized, 1e-15, 1 - 1e-15)
                clipped /= clipped.sum(axis=1, keepdims=True)
                result = float(
                    -np.log(
                        clipped[np.arange(len(y)), [classes.index(t) for t in y]]
                    ).mean()
                )
    if not math.isfinite(result):
        raise InvalidPredictions("Score overflow")
    return {
        "metric": p["metric"],
        "direction": p["direction"],
        "value": result,
        "protocol_sha256": p["protocol_sha256"],
        "scoring_version": p["scoring_version"],
    }


def main():
    request = {}
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Request too large")
        request = json.loads(raw)
        result = {
            "ok": True,
            "score": score_v2(request)
            if isinstance(request, dict) and request.get("version") == 2
            else score(request),
        }
    except Exception as e:
        result = {
            "ok": False,
            "error": {
                "kind": "invalid_predictions"
                if isinstance(e, (InvalidPredictions, InvalidPredictionsV2))
                else "scoring_failure",
                "message": str(e)[:4096],
                **(
                    {"diagnostics": e.diagnostics}
                    if getattr(e, "diagnostics", None) is not None
                    else {}
                ),
            },
        }
    identity = request if isinstance(request, dict) else {}
    protocol = identity.get("protocol")
    print(
        json.dumps(
            {
                "version": 2 if identity.get("version") == 2 else 1,
                "request_id": identity.get("request_id"),
                "protocol_sha256": protocol.get("protocol_sha256")
                if isinstance(protocol, dict)
                else None,
                **result,
            },
            allow_nan=False,
        )
    )


if __name__ == "__main__":
    main()
