"""公开预测契约校验：仅需要允许的样本 ID 和预测，不依赖标签或模型。"""

import csv
import json
from pathlib import Path

import numpy as np

from .dataset_v3 import checked_file
from .limits import validate_limits
from .metrics_v2 import InvalidPredictions, validate_classification_predictions
from .protocol_v2 import fields, prediction_columns_v2, validate_protocol_v2


def validate_predictions(protocol, columns, rows, expected):
    p = validate_protocol_v2(protocol)
    if columns not in (prediction_columns_v2(p), prediction_columns_v2(p, False)):
        raise InvalidPredictions("Invalid prediction columns/target order")
    if (
        not expected
        or len(set(expected)) != len(expected)
        or any(not v.strip() for v in expected)
    ):
        raise ValueError("Invalid expected sample identities")
    if any(len(row) != len(columns) for row in rows):
        raise InvalidPredictions("Prediction row shape mismatch")
    by_id = {row[0]: row for row in rows}
    if len(by_id) != len(rows) or set(by_id) != set(expected):
        raise InvalidPredictions("Prediction membership mismatch")
    aligned = [by_id[identity] for identity in expected]
    result = []
    for target, spec in zip(p["targets"], p["prediction"]["targets"], strict=True):
        values = (
            [row[columns.index(spec["value_column"])] for row in aligned]
            if spec["value_column"]
            else None
        )
        probability = None
        ranked = None
        try:
            if (
                spec["probability_columns"]
                and spec["probability_columns"][0] in columns
            ):
                probability = [
                    [
                        float(row[columns.index(column)])
                        for column in spec["probability_columns"]
                    ]
                    for row in aligned
                ]
            if spec["ranked_column"]:
                ranked = [
                    json.loads(row[columns.index(spec["ranked_column"])])
                    for row in aligned
                ]
            if p["kind"] == "regression":
                values = np.asarray(values, dtype=float)
                if not np.isfinite(values).all():
                    raise ValueError("Non-finite regression predictions")
                if p["metric"]["id"].startswith("rmsle-") and (values <= -1).any():
                    raise ValueError("RMSLE prediction domain error")
            else:
                validate_classification_predictions(
                    target, len(expected), values, probability, ranked
                )
        except (ValueError, TypeError) as error:
            raise InvalidPredictions(f"{target['name']}: {error}") from error
        result.append(
            {
                "target": target["name"],
                "values": values,
                "probabilities": probability,
                "ranked": ranked,
            }
        )
    return result


def read_ids(ref, id_column, limits):
    path = Path(ref["path"])
    checked_file(path.parent, {**ref, "path": path.name}, path.name, limits)
    previous = csv.field_size_limit(limits["max_field_bytes"])
    try:
        with path.open(newline="") as stream:
            reader = csv.reader(stream)
            columns = next(reader)
            if (
                not columns
                or columns[0] != id_column
                or len(columns) > limits["max_columns"]
                or len(set(columns)) != len(columns)
            ):
                raise ValueError("Invalid expected ID file")
            ids, size = [], 0
            for row in reader:
                if len(row) != len(columns) or any(
                    len(v.encode()) > limits["max_field_bytes"] for v in row
                ):
                    raise ValueError("Invalid expected row/field")
                ids.append(row[0])
                size += 256 + len(row[0].encode()) * 4
                if (
                    len(ids) > limits["max_rows"]
                    or size > limits["max_memory_bytes"] // 4
                ):
                    raise ValueError("Expected ID row/memory limit exceeded")
            return ids
    finally:
        csv.field_size_limit(previous)


def validate_files(request):
    from .scoring_v2 import read_table

    fields(
        request,
        ["version", "request_id", "protocol", "expected", "predictions", "limits"],
    )
    if request["version"] != 2 or not isinstance(request["request_id"], str):
        raise ValueError("Invalid prediction request")
    protocol = validate_protocol_v2(request["protocol"])
    limits = validate_limits(request["limits"])
    expected = read_ids(request["expected"], protocol["id_column"], limits)
    columns, rows = read_table(
        request["predictions"],
        {**limits, "max_memory_bytes": limits["max_memory_bytes"] // 2},
    )
    validate_predictions(protocol, columns, rows, expected)
    return {
        "protocol_sha256": protocol["protocol_sha256"],
        "predictions_sha256": request["predictions"]["sha256"],
        "rows": len(expected),
        "targets": [t["name"] for t in protocol["targets"]],
    }


if __name__ == "__main__":
    import sys

    request = {}
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Prediction request too large")
        request = json.loads(raw)
        result = {"ok": True, "result": validate_files(request)}
    except Exception as error:
        result = {"ok": False, "error": str(error)[:4096]}
    print(
        json.dumps(
            {
                "version": 2,
                "request_id": request.get("request_id")
                if isinstance(request, dict)
                else None,
                **result,
            },
            allow_nan=False,
        )
    )
