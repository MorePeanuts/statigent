"""TabArena r0f0 准备：先冻结外层成员，类别只扫描允许训练成员。"""

import csv
import json
from pathlib import Path

from statigent_modeling.data_v3 import prepare_rows
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.limits import validate_limits
from statigent_modeling.protocol_v2 import canonical_json

from .audit import check_split, source_path
from .ds_catalog import sha256
from .tabular_source import decoded_source


def read_members(path, count, limits):
    if count > limits["max_rows"] or count * 256 > limits["max_memory_bytes"] // 4:
        raise ValueError("Outer split row/memory limit exceeded")
    check_split(path, count)
    with path.open(newline="") as stream:
        return {int(row["rowid"]): row["type"] for row in csv.DictReader(stream)}


def tab_sources(root, task):
    paths = {}
    for descriptor in task["files"]:
        path = source_path(root, descriptor["path"])
        if (
            path.stat().st_size != descriptor["bytes"]
            or sha256(path) != descriptor["sha256"]
        ):
            raise ValueError("Changed TabArena source")
        if path.name in paths:
            raise ValueError("Duplicate TabArena source")
        paths[path.name] = path
    return paths


def prepare_tab(root: Path, task: dict, output: Path, *, seed, limits):
    limits = validate_limits(limits)
    if (
        task["benchmark"] != "tabarena-lite"
        or task["openml"]["repeat"] != 0
        or task["openml"]["fold"] != 0
    ):
        raise ValueError("Not a TabArena r0f0 task")
    paths = tab_sources(root, task)
    metadata = json.loads(paths["lite-metadata.json"].read_text())
    description = json.loads(paths["dataset.json"].read_text())["data_set_description"]
    if (
        description["id"] != task["openml"]["dataset_id"]
        or int(description["version"]) != task["openml"]["version"]
        or metadata["task_id_str"] != task["task_id"]
    ):
        raise ValueError("OpenML dataset/task version mismatch")
    count = int(float(metadata["num_instances"]))
    members = read_members(paths["splits-r0-f0.csv"], count, limits)
    raw = [
        path for path in paths.values() if path.suffix in (".arff", ".parquet", ".pq")
    ]
    if len(raw) != 1:
        raise ValueError("Missing/ambiguous raw data")
    raw = raw[0]
    target = metadata["target_name"]
    kind = metadata["problem_type"]
    metric = {
        ("regression", "rmse"): "rmse-v1",
        ("binary", "roc_auc"): "roc-auc-v1",
        ("multiclass", "log_loss"): "log-loss-sklearn-v1",
    }.get((kind, metadata["eval_metric"]))
    if metric is None:
        raise ValueError("Unmapped TabArena task metric")
    training_classes = {}
    class_bytes = 0
    actual_count = 0
    with decoded_source(raw, limits) as (columns, rows):
        if target not in [c["name"] for c in columns] or len(columns) - 1 != int(
            metadata["num_features"]
        ):
            raise ValueError("TabArena source/metadata columns mismatch")
        for index, row in rows:
            actual_count += 1
            if index not in members:
                raise ValueError("Extra raw row")
            if members[index] == "TRAIN" and kind != "regression":
                value = row[target]
                if value is None or not str(value).strip():
                    raise ValueError("Missing training target")
                if (
                    str(value) in training_classes
                    and training_classes[str(value)] != value
                ):
                    raise ValueError("Ambiguous target serialization")
                if str(value) not in training_classes:
                    class_bytes += 256 + len(str(value).encode()) * 8
                if class_bytes > limits["max_memory_bytes"] // 8:
                    raise ValueError("Training class memory limit exceeded")
                training_classes[str(value)] = value
    if actual_count != count:
        raise ValueError("Raw row count mismatch")
    # 与固定 LabelCleaner 的单一原始类型排序一致，不把名义 '01' 转成整数。
    ordered = sorted(training_classes, key=lambda s: training_classes[s])
    if set(training_classes.values()) == {False, True}:
        ordered = sorted(training_classes, key=lambda s: bool(training_classes[s]))
    target_schema = next(c for c in columns if c["name"] == target)
    feature_schema = [c for c in columns if c["name"] != target]
    internal_id = "__sample_id"
    while internal_id in [c["name"] for c in columns]:
        internal_id += "_"
    targets = [
        {
            "name": target,
            "classes": ordered,
            "positive_class": ordered[-1] if kind == "binary" else None,
            "levels": None,
        }
    ]

    def partition(which, private=False):
        with decoded_source(raw, limits) as (_, rows):
            for index, row in rows:
                if members[index] == which:
                    identity = f"openml:{task['openml']['dataset_id']}:{index}"
                    if private:
                        yield identity, [row[target]]
                    else:
                        # 即使源文件同时含测试标签，也不将其传给准备器的特征迭代器。
                        yield (
                            identity,
                            index,
                            {
                                key: value
                                for key, value in row.items()
                                if key != target or which == "TRAIN"
                            },
                        )

    adaptation = {
        "benchmark": task["benchmark"],
        "task_id": task["task_id"],
        "openml": task["openml"],
        "outer_split": "r0f0",
        "ordering": "source-row-ascending",
        "metric": metric,
        "features": feature_schema,
        "targets": targets,
        "notice": (
            "所有搜索和确认划分仅来自冻结 TRAIN 成员；TEST 特征延迟发布，标签仅供评分。"
        ),
    }
    manifest = prepare_rows(
        output,
        kind=kind,
        metric_id=metric,
        id_column=internal_id,
        targets=targets,
        features=feature_schema,
        excluded_columns=[],
        train=partition("TRAIN"),
        prediction=partition("TEST"),
        labels=partition("TEST", True),
        seed=seed,
        limits=limits,
        provenance={
            "benchmark": task["benchmark"],
            "task_id": task["task_id"],
            "source_revision": task["source_revision"],
            "code_revision": task["code_revision"],
            "openml": task["openml"],
            "sources": task["files"],
            "outer_split": task["outer_split"],
            "target_source_schema": target_schema,
            "original_classes": [
                {"canonical": label, "value": training_classes[label]}
                for label in ordered
            ],
        },
        public_context={
            "task.txt": (
                f"{metadata['dataset_name']}：预测 {target}；"
                "固定 TabArena-Lite r0f0。\n"
            ).encode(),
            "adaptation.json": (canonical_json(adaptation) + "\n").encode(),
        },
    )
    tab_sources(root, task)
    load_dataset(output)
    return manifest
