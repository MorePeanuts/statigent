"""带评价分区身份的 V2 数据评分；只接收文件引用，流式校验/读取 CSV。"""

import csv
import hashlib
import json
from pathlib import Path

import numpy as np

from .metrics_v2 import (
    InvalidPredictions,
    MetricUndefined,
    class_vectors,
    classification_metric,
    mean_target_auc,
    regression_metric,
)
from .protocol import probabilities
from .protocol_v2 import fields, prediction_columns_v2, validate_protocol_v2

PARTITIONS = (
    "search-validation",
    "search-training",
    "confirmation-validation",
    "confirmation-training",
    "test",
)
LIMIT_KEYS = (
    "max_file_bytes",
    "max_rows",
    "max_columns",
    "max_field_bytes",
    "max_memory_bytes",
)


def validate_limits(value):
    fields(value, LIMIT_KEYS)
    if any(type(v) is not int or not 1 <= v <= 2**53 - 1 for v in value.values()):
        raise ValueError("Invalid scoring limits")
    return value


def read_table(ref, limits):
    fields(ref, ["path", "sha256", "bytes"])
    path = Path(ref["path"])
    if path.is_symlink() or not path.is_file() or path.resolve() != path:
        raise ValueError("Invalid scoring file")
    if (
        type(ref["bytes"]) is not int
        or ref["bytes"] < 0
        or ref["bytes"] > limits["max_file_bytes"]
    ):
        raise ValueError("Scoring file exceeds limit")
    with path.open("rb") as stream:
        if (
            path.stat().st_size != ref["bytes"]
            or hashlib.file_digest(stream, "sha256").hexdigest() != ref["sha256"]
        ):
            raise ValueError("Scoring file identity mismatch")
        stream.seek(0)
        import io

        # 使用同一描述符，避免哈希后换路径读取；评分不保留完整文本副本。
        text = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
        old_limit = csv.field_size_limit(limits["max_field_bytes"])
        try:
            reader = csv.reader(text)
            columns = next(reader)
            if (
                not columns
                or "" in columns
                or len(set(columns)) != len(columns)
                or len(columns) > limits["max_columns"]
            ):
                raise ValueError("Invalid scoring CSV columns")
            rows = []
            for row in reader:
                if len(row) != len(columns):
                    raise ValueError("Ragged scoring CSV")
                if any(len(cell.encode()) > limits["max_field_bytes"] for cell in row):
                    raise ValueError("Scoring field exceeds limit")
                rows.append(row)
                if (
                    len(rows) > limits["max_rows"]
                    or len(rows) * len(columns) * 128 + ref["bytes"] * 4
                    > limits["max_memory_bytes"]
                ):
                    raise ValueError("Scoring row/memory limit exceeded")
        finally:
            csv.field_size_limit(old_limit)
    return columns, rows


def score_v2(request):
    fields(
        request,
        [
            "version",
            "request_id",
            "protocol",
            "evaluation_id",
            "partition",
            "labels",
            "predictions",
            "limits",
        ],
    )
    import re

    if (
        type(request["version"]) is not int
        or request["version"] != 2
        or not isinstance(request["request_id"], str)
        or not isinstance(request["evaluation_id"], str)
        or re.fullmatch(r"[a-f0-9]{64}", request["evaluation_id"]) is None
        or request["partition"] not in PARTITIONS
    ):
        raise ValueError("Invalid scoring identity")
    p = validate_protocol_v2(request["protocol"])
    limits = validate_limits(request["limits"])
    if (
        sum(ref["bytes"] for ref in [request["labels"], request["predictions"]]) * 8
        > limits["max_memory_bytes"]
    ):
        raise ValueError("Scoring working set exceeds memory limit")
    table_limits = {**limits, "max_memory_bytes": limits["max_memory_bytes"] // 2}
    lc, labels = read_table(request["labels"], table_limits)
    try:
        pc, predictions = read_table(request["predictions"], table_limits)
    except (ValueError, csv.Error, StopIteration, UnicodeError) as error:
        raise InvalidPredictions(str(error)) from error
    if lc != [p["id_column"], *[t["name"] for t in p["targets"]]]:
        raise MetricUndefined("Invalid label columns")
    if pc not in (prediction_columns_v2(p), prediction_columns_v2(p, False)):
        raise InvalidPredictions("Invalid prediction columns/target order")
    ids = [r[0] for r in labels]
    if not ids or any(not v.strip() for v in ids) or len(set(ids)) != len(ids):
        raise MetricUndefined("Invalid label identities")
    by_id = {r[0]: r for r in predictions}
    if len(by_id) != len(predictions) or set(by_id) != set(ids):
        raise InvalidPredictions("Prediction membership mismatch")
    # 原评价成员顺序决定 Gini 平局，不按预测文件行序或 ID 字典序重排。
    predictions = [by_id[identity] for identity in ids]
    label_values = {
        t["name"]: [row[index + 1] for row in labels]
        for index, t in enumerate(p["targets"])
    }
    probability_by_target = {}
    target_predictions = []
    for target, columns in zip(p["targets"], p["prediction"]["targets"], strict=True):
        values = (
            [r[pc.index(columns["value_column"])] for r in predictions]
            if columns["value_column"]
            else None
        )
        probability = (
            [
                [r[pc.index(c)] for c in columns["probability_columns"]]
                for r in predictions
            ]
            if columns["probability_columns"]
            and columns["probability_columns"][0] in pc
            else None
        )
        try:
            ranked = (
                [json.loads(r[pc.index(columns["ranked_column"])]) for r in predictions]
                if columns["ranked_column"]
                else None
            )
        except (ValueError, TypeError) as error:
            raise InvalidPredictions("Invalid ranked JSON") from error
        if p["kind"] == "multilabel":
            # 校验每目标派生标签与概率一致；不能跨目标归一化。
            _, encoded = class_vectors(target, label_values[target["name"]], values)
            try:
                checked = probabilities(probability, len(labels), 2)
            except (TypeError, ValueError) as error:
                raise InvalidPredictions(f"{target['name']}: {error}") from error
            if encoded is None or not np.array_equal(
                encoded, np.argmax(checked, axis=1)
            ):
                raise InvalidPredictions(
                    f"{target['name']}: probability label mismatch"
                )
            probability_by_target[target["name"]] = checked
        else:
            target_predictions.append((values, probability, ranked))
    components = []
    if p["kind"] == "multilabel":
        score = mean_target_auc(p["targets"], label_values, probability_by_target)
        value, components = score["value"], score["targets"]
    else:
        target = p["targets"][0]
        values, probability, ranked = target_predictions[0]
        actual = label_values[target["name"]]
        if p["kind"] == "regression":
            value = regression_metric(p["metric"]["id"], actual, values)
        else:
            value = classification_metric(
                p["metric"]["id"], target, actual, values, probability, ranked
            )
    return {
        "metric": p["metric"]["id"],
        "direction": p["metric"]["direction"],
        "value": value,
        "protocol_sha256": p["protocol_sha256"],
        "scoring_version": p["scoring_version"],
        "metric_definition_sha256": p["metric"]["definition_sha256"],
        "evaluation_id": request["evaluation_id"],
        "partition": request["partition"],
        "components": components,
    }
