"""冻结预测的逐目标复现比较；指标相同不代表预测相同。"""

import json

import numpy as np

from .limits import validate_limits
from .predictions_v2 import read_ids, validate_predictions
from .protocol_v2 import fields, validate_protocol_v2
from .scoring_v2 import read_table

TOLERANCE = {"atol": 1e-8, "rtol": 1e-6}


def compare_files(request):
    fields(
        request,
        [
            "version",
            "request_id",
            "protocol",
            "expected",
            "reference",
            "actual",
            "limits",
            "tolerance",
        ],
    )
    if request["version"] != 2 or not isinstance(request["request_id"], str):
        raise ValueError("Invalid comparison request")
    if request["tolerance"] != TOLERANCE:
        raise ValueError("Prediction comparison tolerance is frozen")
    p, limits = (
        validate_protocol_v2(request["protocol"]),
        validate_limits(request["limits"]),
    )
    expected = read_ids(request["expected"], p["id_column"], limits)
    reduced = {**limits, "max_memory_bytes": limits["max_memory_bytes"] // 4}
    left_columns, left_rows = read_table(request["reference"], reduced)
    right_columns, right_rows = read_table(request["actual"], reduced)
    left = validate_predictions(p, left_columns, left_rows, expected)
    right = validate_predictions(p, right_columns, right_rows, expected)
    differences = []
    if left_columns != right_columns:
        differences.append("columns")
    for a, b in zip(left, right, strict=True):
        for field in ["values", "probabilities", "ranked"]:
            av, bv = a[field], b[field]
            if av is None or bv is None:
                same = av is None and bv is None
            elif field == "probabilities" or (
                field == "values" and p["kind"] == "regression"
            ):
                with np.errstate(over="ignore", invalid="ignore"):
                    same = bool(np.allclose(bv, av, **TOLERANCE))
            else:
                same = av == bv
            if not same:
                differences.append(f"{a['target']}/{field}")
    return {
        "protocol_sha256": p["protocol_sha256"],
        "reference_sha256": request["reference"]["sha256"],
        "actual_sha256": request["actual"]["sha256"],
        "rows": len(expected),
        "matched": not differences,
        "differences": differences,
        "tolerance": TOLERANCE,
    }


if __name__ == "__main__":
    import sys

    request = {}
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Comparison request too large")
        request = json.loads(raw)
        result = {"ok": True, "result": compare_files(request)}
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
