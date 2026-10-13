"""仅在锁定的可选官方环境中，对同一冻结预测调用真实 TabArena 评分。"""

import csv
import json
import math
import sys
import time
from pathlib import Path

from statigent_modeling.data_v3 import decode_cell
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.predictions_v2 import validate_predictions
from statigent_modeling.protocol_v2 import fields
from statigent_modeling.scoring_v2 import read_table

from .tabarena_compat import verify_environment


def compare(request):
    fields(
        request,
        [
            "version",
            "request_id",
            "prepared_root",
            "dataset_sha256",
            "predictions",
            "native_score",
        ],
    )
    if type(request["version"]) is not int or request["version"] != 1:
        raise ValueError("Invalid official comparison request")
    start = time.monotonic()
    environment = verify_environment()
    import pandas as pd
    from autogluon.core.data.label_cleaner import LabelCleaner
    from autogluon.core.metrics import get_metric
    from tabarena.benchmark.experiment.experiment_runner import evaluate

    root = Path(request["prepared_root"])
    manifest = load_dataset(root)
    p, limits, source = manifest["protocol"], manifest["limits"], manifest["provenance"]
    if (
        manifest["dataset_sha256"] != request["dataset_sha256"]
        or source.get("benchmark") != "tabarena-lite"
        or source.get("outer_split") != "openml-r0f0"
        or source.get("openml", {}).get("repeat") != 0
        or source.get("openml", {}).get("fold") != 0
    ):
        raise ValueError("Official comparison requires matching r0f0 dataset")
    native = request["native_score"]
    if type(native) not in (float, int) or not math.isfinite(native):
        raise ValueError("Invalid native score")
    labels = manifest["evaluator"]["labels"]
    if labels is None:
        raise ValueError("Missing private labels")
    # 为训练标签、对齐副本、pandas 与官方转换保留独立工作集余量。
    bounded = {**limits, "max_memory_bytes": limits["max_memory_bytes"] // 8}
    lc, lr = read_table({**labels, "path": str(root / labels["path"])}, bounded)
    pc, pr = read_table(request["predictions"], bounded)
    target = p["targets"][0]
    if lc != [p["id_column"], target["name"]]:
        raise ValueError("Official label columns mismatch")
    result = validate_predictions(p, pc, pr, [r[0] for r in lr])[0]
    kind = p["kind"]
    expected_metric = {
        "regression": "rmse-v1",
        "binary": "roc-auc-v1",
        "multiclass": "log-loss-sklearn-v1",
    }.get(kind)
    if p["metric"]["id"] != expected_metric:
        raise ValueError("Official metric mapping mismatch")
    metric_name = {"regression": "rmse", "binary": "roc_auc", "multiclass": "log_loss"}[
        kind
    ]
    ordered = []
    if kind == "regression":
        y = pd.Series([float(r[1]) for r in lr])
        predicted, probabilities, cleaner = pd.Series(result["values"]), None, None
    else:
        mapping = {
            item["canonical"]: item["value"] for item in source["original_classes"]
        }
        if list(mapping) != target["classes"]:
            raise ValueError("Frozen original class order mismatch")
        previous = csv.field_size_limit(limits["max_field_bytes"])
        try:
            with (root / manifest["training"]["path"]).open(newline="") as stream:
                train_y = []
                for row in csv.DictReader(stream):
                    train_y.append(mapping[str(decode_cell(row[target["name"]]))])
                    if len(train_y) * 256 > limits["max_memory_bytes"] // 8:
                        raise ValueError("Official training label memory limit")
        finally:
            csv.field_size_limit(previous)
        cleaner = LabelCleaner.construct(problem_type=kind, y=pd.Series(train_y))
        ordered = list(cleaner.ordered_class_labels)
        if ordered != list(mapping.values()):
            raise ValueError("Official LabelCleaner class order drift")
        if kind == "binary" and mapping[target["positive_class"]] != ordered[1]:
            raise ValueError("Official positive class mismatch")
        y = pd.Series([mapping[r[1]] for r in lr])
        probabilities = pd.DataFrame(result["probabilities"], columns=ordered)
        predicted = pd.Series([mapping[v] for v in result["values"]])
    error = float(
        evaluate(
            y, predicted, probabilities, get_metric(metric_name, kind), kind, cleaner
        )
    )
    expected = 1 - native if kind == "binary" else native
    if not math.isfinite(error) or not math.isclose(
        error, expected, abs_tol=1e-10, rel_tol=1e-10
    ):
        raise ValueError(f"Official scoring difference: {error} != {expected}")
    # 再验证来源，评分过程不修改冻结材料。
    if load_dataset(root)["dataset_sha256"] != manifest["dataset_sha256"]:
        raise ValueError("Comparison source changed")
    read_table(request["predictions"], bounded)
    return {
        "status": "passed",
        "scope": "official-frozen-prediction-differential",
        "dataset_sha256": manifest["dataset_sha256"],
        "task_id": source["task_id"],
        "openml": source["openml"],
        "predictions": request["predictions"],
        "labels_sha256": labels["sha256"],
        "native_value": native,
        "official_error": error,
        "metric": metric_name,
        "canonical_classes": target["classes"],
        "original_classes": ordered,
        "code_commit": environment["code_commit"],
        "environment_lock_sha256": environment["environment_lock_sha256"],
        "dependencies": environment["metric_dependencies"],
        "calls": {"models": 0, "fits": 0},
        "elapsed_ms": (time.monotonic() - start) * 1000,
    }


if __name__ == "__main__":
    request = {}
    try:
        raw = sys.stdin.buffer.read(1024**2 + 1)
        if len(raw) > 1024**2:
            raise ValueError("Official request limit")
        request = json.loads(raw)
        result = {"ok": True, "result": compare(request)}
    except Exception as error:
        result = {"ok": False, "error": str(error)[:4096]}
    print(
        json.dumps(
            {
                "version": 1,
                "request_id": request.get("request_id")
                if isinstance(request, dict)
                else None,
                **result,
            },
            allow_nan=False,
        )
    )
