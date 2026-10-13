"""DSBench 发布数据的确定性适配；源文件只读，私有标签不参与类型或类别推断。"""

import csv
import json
import math
from pathlib import Path

from statigent_modeling.data_v3 import prepare_rows
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.protocol_v2 import canonical_json

from .audit import source_path
from .ds_catalog import MAPPINGS, sha256


def verify_sources(root, task):
    paths = {}
    for ref in [*task["files"], task["protocol"]["scorer"]]:
        path = source_path(root, ref["path"])
        if path.stat().st_size != ref["bytes"] or sha256(path) != ref["sha256"]:
            raise ValueError(f"Changed benchmark source: {ref['path']}")
        if ref in task["files"]:
            if ref["access"] in paths:
                raise ValueError("Duplicate source role")
            paths[ref["access"]] = path
    if set(paths) != {"training", "prediction", "evaluator", "description"}:
        raise ValueError("Missing source role")
    return paths


def csv_rows(path, limits):
    if path.stat().st_size > limits["max_file_bytes"]:
        raise ValueError("Source CSV file limit exceeded")
    previous = csv.field_size_limit(limits["max_field_bytes"])
    try:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            columns = reader.fieldnames
            if (
                not columns
                or "" in columns
                or len(set(columns)) != len(columns)
                or len(columns) > limits["max_columns"]
            ):
                raise ValueError("Invalid source CSV columns")
            for index, row in enumerate(reader):
                if index >= limits["max_rows"] or None in row or None in row.values():
                    raise ValueError("Source CSV row/shape limit exceeded")
                if any(
                    len(value.encode()) > limits["max_field_bytes"]
                    for value in row.values()
                ):
                    raise ValueError("Source CSV field limit exceeded")
                yield index, row
    finally:
        csv.field_size_limit(previous)


def positive_class(classes):
    for negative, positive in [("0", "1"), ("0.0", "1.0"), ("False", "True")]:
        if set(classes) == {negative, positive}:
            return positive
    raise ValueError("Unmapped DSBench positive class")


def prepare_ds(root: Path, task: dict, output: Path, *, seed: int, limits: dict):
    if task["benchmark"] != "dsbench-modeling" or task["task_id"] not in MAPPINGS:
        raise ValueError("Unknown DSBench task")
    mapping, declared = MAPPINGS[task["task_id"]], task["protocol"]
    if (
        declared["targets"] != mapping["targets"]
        or declared["kind"] != mapping["kind"]
        or declared["metric"]["id"] != mapping["metric"]
    ):
        raise ValueError("DSBench mapping mismatch")
    paths = verify_sources(root, task)
    feature_names = declared["feature_columns"]
    target_names = declared["targets"]
    numeric = {name: True for name in feature_names}
    observed = {name: False for name in feature_names}
    classes = {name: set() for name in target_names}
    train_count = 0
    for _, row in csv_rows(paths["training"], limits):
        train_count += 1
        for name in feature_names:
            if row[name] == "":
                continue
            observed[name] = True
            try:
                numeric[name] &= math.isfinite(float(row[name]))
            except ValueError:
                numeric[name] = False
        if declared["kind"] != "regression":
            for name in target_names:
                classes[name].add(row[name])
    if not train_count:
        raise ValueError("Empty DSBench training")
    targets = []
    for name in target_names:
        values = sorted(classes[name], key=lambda s: s.encode())
        if declared["prediction_form"] == "ranked-labels" and any(
            any(c.isspace() for c in value) for value in values
        ):
            raise ValueError("DSBench ranked label cannot contain whitespace")
        targets.append(
            {
                "name": name,
                "classes": values,
                "positive_class": positive_class(values)
                if declared["kind"] in ("binary", "multilabel")
                else None,
                "levels": [int(value) for value in values]
                if declared["kind"] == "ordinal"
                else None,
            }
        )
    source_id = declared["identity"]["column"]
    if declared["identity"]["strategy"] != (
        "source-column" if source_id else "source-row"
    ):
        raise ValueError("Invalid DSBench identity strategy")
    internal_id = "__sample_id"
    while internal_id in feature_names + target_names:
        internal_id += "_"

    def identity(partition, index, row):
        # 前缀区分两份发布文件；原始字符串 ID 完整保存，不做数值转换。
        return f"{partition}:{row[source_id]}" if source_id else f"{partition}:{index}"

    expected_features = set(feature_names)
    test_count = 0
    export_column = mapping["id_column"]
    for _, row in csv_rows(paths["prediction"], limits):
        if set(row) - ({source_id} if source_id else set()) != expected_features:
            raise ValueError("Published prediction columns differ from whitelist")
        test_count += 1
    # 无原始 ID 的来源使用冻结行序导出；不从目标/预测值推测身份。
    with paths["prediction"].open(encoding="utf-8-sig", newline="") as stream:
        original_columns = next(csv.reader(stream))
    export_source = export_column if export_column in original_columns else None

    def partition_rows(role, partition):
        for index, row in csv_rows(paths[role], limits):
            canonical_id = identity(partition, index, row)
            for name in feature_names:
                if row[name] == "":
                    row[name] = None
            yield canonical_id, index, row

    def private_labels():
        for index, row in csv_rows(paths["evaluator"], limits):
            yield identity("test", index, row), [row[name] for name in target_names]

    adaptation = {
        "benchmark": task["benchmark"],
        "task_id": task["task_id"],
        "published_rows": {"training": train_count, "prediction": test_count},
        "feature_columns": feature_names,
        "excluded_columns": declared["excluded_columns"],
        "targets": targets,
        "metric": declared["metric"],
        "issues": task["issues"],
        "notice": (
            "交付行数以发布数据为准；原题面可能描述原 Kaggle 全量数据。"
            "测试特征在模型冻结后才发布。"
        ),
    }
    manifest = prepare_rows(
        output,
        kind=declared["kind"],
        metric_id=declared["metric"]["id"],
        id_column=internal_id,
        targets=targets,
        features=[
            {
                "name": name,
                "kind": "numeric" if numeric[name] and observed[name] else "string",
                "source_type": "CSV/training-inferred-v1",
                "categories": None,
            }
            for name in feature_names
        ],
        excluded_columns=declared["excluded_columns"],
        train=partition_rows("training", "train"),
        prediction=partition_rows("prediction", "test"),
        labels=private_labels(),
        seed=seed,
        limits=limits,
        export_id_column=export_source,
        provenance={
            "benchmark": task["benchmark"],
            "task_id": task["task_id"],
            "source_revision": task["source_revision"],
            "code_revision": task["code_revision"],
            "outer_split": task["outer_split"],
            "sources": task["files"],
            "scorer": declared["scorer"],
            "export": {
                "columns": declared["prediction_columns"],
                "identity": "source-column" if export_source else "source-row",
            },
        },
        public_context={
            "task.txt": paths["description"].read_bytes(),
            "adaptation.json": (canonical_json(adaptation) + "\n").encode(),
        },
    )
    verify_sources(root, task)
    load_dataset(output)
    return manifest


def export_predictions(prepared: Path, predictions: Path, destination: Path):
    """规范预测按冻结发布行序导出，不执行上游脚本或反序列化模型。"""
    from statigent_modeling.metrics_v2 import validate_classification_predictions
    from statigent_modeling.protocol_v2 import prediction_columns_v2
    from statigent_modeling.scoring_v2 import read_table

    manifest = load_dataset(prepared)
    if manifest["provenance"].get("benchmark") != "dsbench-modeling":
        raise ValueError("Not a DSBench dataset")
    protocol, limits = manifest["protocol"], manifest["limits"]
    columns, rows = read_table(
        {
            "path": str(predictions.resolve()),
            "bytes": predictions.stat().st_size,
            "sha256": sha256(predictions),
        },
        limits,
    )
    if columns not in (
        prediction_columns_v2(protocol),
        prediction_columns_v2(protocol, False),
    ):
        raise ValueError("Invalid canonical prediction columns")
    by_id = {row[0]: dict(zip(columns, row, strict=True)) for row in rows}
    if len(by_id) != len(rows):
        raise ValueError("Duplicate prediction identity")
    mapping = []
    with (prepared / manifest["evaluator"]["source_rows"]["path"]).open() as stream:
        for line in stream:
            item = json.loads(line)
            if item["partition"] == "prediction":
                mapping.append(item)
    if set(by_id) != {item["id"] for item in mapping}:
        raise ValueError("Prediction membership mismatch")
    output_rows = []
    for item in mapping:
        row = by_id[item["id"]]
        result = [
            item["export_id"] if item["export_id"] is not None else item["source_row"]
        ]
        for target, spec in zip(
            protocol["targets"], protocol["prediction"]["targets"], strict=True
        ):
            if protocol["output"] == "numeric":
                value = float(row[spec["value_column"]])
                if not math.isfinite(value):
                    raise ValueError("Non-finite exported prediction")
                result.append(value)
            elif protocol["output"] == "label":
                value = row[spec["value_column"]]
                if value not in target["classes"]:
                    raise ValueError("Unknown exported label")
                result.append(value)
            elif protocol["output"] == "ranked-labels":
                ranked = json.loads(row[spec["ranked_column"]])
                optional = spec["probability_columns"]
                matrix = (
                    [[float(row[c]) for c in optional]]
                    if all(c in row for c in optional)
                    else None
                )
                validate_classification_predictions(
                    target, 1, ranked=[ranked], proba=matrix
                )
                if any(any(c.isspace() for c in value) for value in ranked):
                    raise ValueError("Ambiguous DSBench whitespace export")
                result.append(" ".join(ranked))
            else:
                matrix = [[float(row[c]) for c in spec["probability_columns"]]]
                validate_classification_predictions(
                    target,
                    1,
                    predicted=[row[spec["value_column"]]],
                    proba=matrix,
                )
                result.append(
                    matrix[0][target["classes"].index(target["positive_class"])]
                )
        output_rows.append(result)
    with destination.open("x", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(manifest["provenance"]["export"]["columns"])
        writer.writerows(output_rows)
    return {
        "path": str(destination),
        "bytes": destination.stat().st_size,
        "sha256": sha256(destination),
    }
