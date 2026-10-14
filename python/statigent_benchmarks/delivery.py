"""受信基准导出；只读准备数据与规范预测，不执行模型或生成代码。"""

import csv
import json
import sys
from pathlib import Path

from statigent_modeling.data_v3 import file_descriptor
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.predictions_v2 import validate_files
from statigent_modeling.protocol_v2 import fields
from statigent_modeling.scoring_v2 import read_table

from .prepare_ds import export_predictions


def export_tabarena(root, manifest, predictions, destination):
    protocol, limits = manifest["protocol"], manifest["limits"]
    kind = protocol["kind"]
    if kind not in ("regression", "binary", "multiclass"):
        raise ValueError("Invalid TabArena target kind")
    columns, rows = read_table(
        predictions, {**limits, "max_memory_bytes": limits["max_memory_bytes"] // 4}
    )
    by_id = {r[0]: r for r in rows}
    target, spec = protocol["targets"][0], protocol["prediction"]["targets"][0]
    selected = (
        [spec["value_column"]]
        if kind == "regression"
        else [
            spec["probability_columns"][
                target["classes"].index(target["positive_class"])
            ]
        ]
        if kind == "binary"
        else spec["probability_columns"]
    )
    names = (
        [target["name"]]
        if kind == "regression"
        else [target["positive_class"]]
        if kind == "binary"
        else target["classes"]
    )
    with destination.open("x", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(["source_row", *names])
        # 发布行序等于评分固定成员顺序，不能用字典排序改变并列语义。
        with (root / manifest["evaluator"]["source_rows"]["path"]).open() as source:
            for line in source:
                member = json.loads(line)
                if member["partition"] != "prediction":
                    continue
                row = by_id[member["id"]]
                writer.writerow(
                    [member["source_row"], *[row[columns.index(c)] for c in selected]]
                )
                if output.tell() > limits["max_file_bytes"]:
                    raise ValueError("TabArena export file limit")


def export_delivery(request):
    fields(
        request,
        [
            "version",
            "request_id",
            "prepared_root",
            "dataset_sha256",
            "predictions",
            "destination",
        ],
    )
    if type(request["version"]) is not int or request["version"] != 1:
        raise ValueError("Invalid export request version")
    root, destination = Path(request["prepared_root"]), Path(request["destination"])
    if root.resolve() != root or destination.resolve() != destination:
        raise ValueError("Export paths must be canonical")
    manifest = load_dataset(root)
    if (
        manifest["dataset_sha256"] != request["dataset_sha256"]
        or not manifest["prediction"]
    ):
        raise ValueError("Export dataset identity mismatch")
    validate_files(
        dict(
            version=2,
            request_id=request["request_id"],
            protocol=manifest["protocol"],
            expected={
                **manifest["prediction"],
                "path": str(root / manifest["prediction"]["path"]),
            },
            predictions=request["predictions"],
            limits=manifest["limits"],
        )
    )
    benchmark = manifest["provenance"].get("benchmark")
    if benchmark == "dsbench-modeling":
        export_predictions(root, Path(request["predictions"]["path"]), destination)
    elif benchmark == "tabarena-lite":
        export_tabarena(root, manifest, request["predictions"], destination)
    else:
        raise ValueError("Unknown benchmark export")
    return {
        "dataset_sha256": manifest["dataset_sha256"],
        "export": file_descriptor(
            destination.parent, destination.name, manifest["limits"]
        ),
        "calls": {"models": 0, "fits": 0},
    }


if __name__ == "__main__":
    request = {}
    try:
        raw = sys.stdin.buffer.read(1024**2 + 1)
        if len(raw) > 1024**2:
            raise ValueError("Export request limit")
        request = json.loads(raw)
        result = {"ok": True, "result": export_delivery(request)}
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
