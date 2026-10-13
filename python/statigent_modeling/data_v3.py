"""分阶段准备的通用数据层；基准只负责来源解码和固定外层成员。"""

import csv
import hashlib
import json
import math
import time
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from .protocol_v2 import canonical_json, create_protocol_v2, digest, fields
from .scoring_v2 import validate_limits

MISSING_TOKEN = "__statigent_null_v1__"
ESCAPE_PREFIX = "__statigent_escaped_v1__"


def validate_features(features):
    if not isinstance(features, list) or not features:
        raise ValueError("Invalid feature schema")
    for feature in features:
        fields(feature, ["name", "kind", "source_type", "categories"])
        if (
            not isinstance(feature["name"], str)
            or not feature["name"].strip()
            or feature["kind"]
            not in ("numeric", "categorical", "string", "boolean", "datetime")
            or not isinstance(feature["source_type"], str)
            or not feature["source_type"].strip()
        ):
            raise ValueError("Invalid feature description")
        categories = feature["categories"]
        if categories is not None and (
            not isinstance(categories, list)
            or not all(isinstance(v, str) for v in categories)
            or len(set(categories)) != len(categories)
        ):
            raise ValueError("Invalid nominal feature categories")
    if len({f["name"] for f in features}) != len(features):
        raise ValueError("Duplicate feature")
    return features


def encode_cell(value):
    if value is None:
        return MISSING_TOKEN
    value = str(value)
    return (
        ESCAPE_PREFIX + value
        if value == MISSING_TOKEN or value.startswith(ESCAPE_PREFIX)
        else value
    )


def decode_cell(value):
    if value == MISSING_TOKEN:
        return None
    return value[len(ESCAPE_PREFIX) :] if value.startswith(ESCAPE_PREFIX) else value


def file_descriptor(root, relative, limits):
    path = root / relative
    size = path.stat().st_size
    if size > limits["max_file_bytes"]:
        raise ValueError(f"Prepared file exceeds limit: {relative}")
    with path.open("rb") as stream:
        sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"path": relative, "bytes": size, "sha256": sha256}


def write_json(root, relative, value, limits):
    path = root / relative
    with path.open("x") as stream:
        stream.write(canonical_json(value) + "\n")
    return file_descriptor(root, relative, limits)


def split_rows(ids, target_values, protocol, seed, explicit=None):
    def order(group):
        return sorted(
            group,
            key=lambda identity: (
                hashlib.sha256(f"{seed}:{identity}".encode()).hexdigest(),
                identity.encode(),
            ),
        )

    if explicit is not None:
        if not isinstance(explicit, dict) or set(explicit) != {"train", "validation"}:
            raise ValueError("Invalid explicit split")
        fit, validation = explicit["train"], explicit["validation"]
        method = "explicit-v1"
    elif protocol["kind"] in ("regression", "multilabel"):
        ordered = order(ids)
        count = max(1, math.floor(len(ids) * 0.2))
        validation, fit = ordered[:count], ordered[count:]
        method = "multilabel-hash-v1" if protocol["kind"] == "multilabel" else "hash-v1"
    else:
        fit, validation = [], []
        target = protocol["targets"][0]
        by_id = dict(zip(ids, target_values[target["name"]], strict=True))
        for label in target["classes"]:
            ordered = order([identity for identity in ids if by_id[identity] == label])
            if len(ordered) < 2:
                raise ValueError(f"Rare class cannot be split: {target['name']}")
            count = max(1, min(len(ordered) - 1, math.floor(len(ordered) * 0.2)))
            validation.extend(ordered[:count])
            fit.extend(ordered[count:])
        method = "stratified-hash-v1"
    if (
        not isinstance(fit, list)
        or not isinstance(validation, list)
        or not fit
        or not validation
        or len(fit) + len(validation) != len(ids)
        or len(set(fit + validation)) != len(ids)
        or set(fit + validation) != set(ids)
    ):
        raise ValueError("Invalid internal split members")
    by_index = {identity: index for index, identity in enumerate(ids)}
    for target in protocol["targets"]:
        if protocol["kind"] == "regression":
            continue
        for partition, members in [("train", fit), ("validation", validation)]:
            if {target_values[target["name"]][by_index[i]] for i in members} != set(
                target["classes"]
            ):
                raise ValueError(f"Class coverage failed: {target['name']}/{partition}")
    if protocol["metric"]["id"] == "r2-sklearn-v1" and len(validation) < 2:
        raise ValueError("R2 validation needs at least two members")
    # 保持旧成员哈希的键顺序，不能用 v2 通用 sort_keys 改写旧算法身份。
    members = {"train": fit, "validation": validation}
    sha256 = hashlib.sha256(
        json.dumps(members, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return {"version": 1, "method": method, "seed": seed, **members, "sha256": sha256}


def prepare_rows(
    root: Path,
    *,
    kind: str,
    metric_id: str,
    id_column: str,
    targets: list[dict],
    features: list[dict],
    excluded_columns: list[str],
    train: Iterable[tuple[str, int, dict]],
    prediction: Iterable[tuple[str, int, dict]] | None,
    labels: Iterable[tuple[str, list]] | None,
    seed: int,
    limits: dict,
    provenance: dict,
    export_id_column: str | None = None,
    explicit_split=None,
) -> dict:
    """输入迭代器是可信解码后的允许成员；源行号不可由数据内容猜测。"""
    started = time.monotonic()
    limits = validate_limits(limits)
    if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
        raise ValueError("Invalid dataset seed")
    validate_features(features)
    if not isinstance(targets, list) or not targets:
        raise ValueError("Invalid target configurations")
    for target in targets:
        fields(target, ["name", "classes", "positive_class", "levels"])
        if not isinstance(target["name"], str) or not target["name"].strip():
            raise ValueError("Invalid target name")
    if (
        not isinstance(excluded_columns, list)
        or not all(isinstance(v, str) and v.strip() for v in excluded_columns)
        or len(set(excluded_columns)) != len(excluded_columns)
        or not isinstance(provenance, dict)
    ):
        raise ValueError("Invalid exclusions/provenance")
    feature_names = [f["name"] for f in features]
    names = [t["name"] for t in targets]
    if (
        not names
        or not feature_names
        or len(set(names)) != len(names)
        or len(set(feature_names)) != len(feature_names)
        or set(feature_names) & {id_column, *names, *excluded_columns}
        or id_column in names
    ):
        raise ValueError("Feature/target/identity leakage")
    if len(feature_names) + len(names) + 1 > limits["max_columns"]:
        raise ValueError("Column limit exceeded")
    root.mkdir()  # 现存目录不可覆盖，包括先前失败的准备。
    for directory in ["search", "final-prediction", "evaluator"]:
        (root / directory).mkdir()
    try:
        seen = set()
        retained_bytes = 0
        train_ids, prediction_ids = [], []
        target_values = {name: [] for name in names}
        mapping_path = root / "evaluator/source-rows.jsonl"
        with mapping_path.open("x") as mappings:

            def write_rows(relative, rows, training):
                nonlocal retained_bytes
                columns = [id_column, *feature_names, *(names if training else [])]
                collected = train_ids if training else prediction_ids
                source_rows = set()
                with (root / relative).open("x", newline="") as stream:
                    writer = csv.writer(stream)
                    writer.writerow(columns)
                    for identity, source_row, data in rows:
                        if (
                            not isinstance(identity, str)
                            or not identity.strip()
                            or identity in seen
                            or type(source_row) is not int
                            or source_row < 0
                            or source_row in source_rows
                        ):
                            raise ValueError("Duplicate/invalid source identity")
                        seen.add(identity)
                        source_rows.add(source_row)
                        retained_bytes += 256 + 8 * len(identity.encode())
                        collected.append(identity)
                        if len(collected) > limits["max_rows"]:
                            raise ValueError("Row limit exceeded")
                        output = [
                            identity,
                            *[encode_cell(data[name]) for name in feature_names],
                        ]
                        if training:
                            for name in names:
                                value = data[name]
                                if value is None or not str(value).strip():
                                    raise ValueError(f"Missing target: {name}")
                                value = str(value)
                                if kind == "regression" and not math.isfinite(
                                    float(value)
                                ):
                                    raise ValueError("Non-finite regression target")
                                target_values[name].append(value)
                                retained_bytes += 128 + 4 * len(value.encode())
                                output.append(value)
                        if any(
                            len(v.encode()) > limits["max_field_bytes"] for v in output
                        ):
                            raise ValueError("Field limit exceeded")
                        writer.writerow(output)
                        if stream.tell() > limits["max_file_bytes"]:
                            raise ValueError("Prepared file limit exceeded")
                        if retained_bytes * 3 > limits["max_memory_bytes"]:
                            raise ValueError(
                                "Preparation membership memory limit exceeded"
                            )
                        mappings.write(
                            canonical_json(
                                {
                                    "id": identity,
                                    "partition": "training"
                                    if training
                                    else "prediction",
                                    "source_row": source_row,
                                    "export_id": None
                                    if export_id_column is None
                                    else data[export_id_column],
                                }
                            )
                            + "\n"
                        )
                        if mappings.tell() > limits["max_file_bytes"]:
                            raise ValueError("Source mapping file limit exceeded")
                if not collected:
                    raise ValueError("Empty prepared partition")
                return file_descriptor(root, relative, limits)

            training_file = write_rows("search/train.csv", train, True)
            prediction_file = (
                write_rows("final-prediction/test.csv", prediction, False)
                if prediction is not None
                else None
            )
        frozen_targets = []
        for target in targets:
            name = target["name"]
            classes = (
                []
                if kind == "regression"
                else sorted(set(target_values[name]), key=lambda s: s.encode())
            )
            if target.get("classes") is not None:
                if set(target["classes"]) != set(classes):
                    raise ValueError("Declared class set differs from training")
                classes = target["classes"]
            frozen_targets.append(
                {
                    "name": name,
                    "classes": classes,
                    "positive_class": target.get("positive_class"),
                    "levels": target.get("levels"),
                }
            )
        protocol = create_protocol_v2(
            {
                "kind": kind,
                "metric_id": metric_id,
                "id_column": id_column,
                "feature_columns": feature_names,
                "targets": frozen_targets,
            }
        )
        split = split_rows(train_ids, target_values, protocol, seed, explicit_split)
        split_file = write_json(root, "search/split.json", split, limits)
        schema_file = write_json(
            root,
            "search/features.json",
            {
                "version": 1,
                "encoding": "escaped-null-v1",
                "missing_token": MISSING_TOKEN,
                "escape_prefix": ESCAPE_PREFIX,
                "columns": features,
            },
            limits,
        )
        labels_file = None
        if labels is not None:
            if prediction_file is None:
                raise ValueError("Labels without prediction partition")
            by_id = {}
            for identity, values in labels:
                if (
                    not isinstance(identity, str)
                    or not isinstance(values, (list, tuple))
                    or identity not in seen
                    or identity in by_id
                    or len(values) != len(names)
                    or any(v is None or not str(v).strip() for v in values)
                ):
                    raise ValueError("Invalid private labels")
                values = [str(v) for v in values]
                for target, value in zip(frozen_targets, values, strict=True):
                    if len(value.encode()) > limits["max_field_bytes"]:
                        raise ValueError("Private label field limit exceeded")
                    if kind == "regression":
                        if not math.isfinite(float(value)):
                            raise ValueError("Non-finite private regression label")
                    elif value not in target["classes"]:
                        raise ValueError(f"Unknown private class: {target['name']}")
                by_id[identity] = values
                retained_bytes += 256 + sum(128 + 4 * len(v.encode()) for v in values)
                if retained_bytes * 3 > limits["max_memory_bytes"]:
                    raise ValueError("Private label memory limit exceeded")
            if set(by_id) != set(prediction_ids):
                raise ValueError("Private label membership mismatch")
            with (root / "evaluator/labels.csv").open("x", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow([id_column, *names])
                writer.writerows(
                    [identity, *by_id[identity]] for identity in prediction_ids
                )
            labels_file = file_descriptor(root, "evaluator/labels.csv", limits)
        manifest = {
            "schema_version": 3,
            "protocol": protocol,
            "seed": seed,
            "limits": limits,
            "excluded_columns": excluded_columns,
            "training": training_file,
            "prediction": prediction_file,
            "evaluator": {
                "labels": labels_file,
                "source_rows": file_descriptor(
                    root, "evaluator/source-rows.jsonl", limits
                ),
            },
            "feature_schema": schema_file,
            "split": {
                "file": split_file,
                "method": split["method"],
                "train_rows": len(split["train"]),
                "validation_rows": len(split["validation"]),
            },
            "rows": {"training": len(train_ids), "prediction": len(prediction_ids)},
            "provenance": provenance,
            "preparation": {
                "created_at": datetime.now(UTC).isoformat(),
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "reused_from": None,
            },
        }
        manifest["dataset_sha256"] = digest(manifest)
        write_json(root, "dataset.json", manifest, limits)
        for file in root.rglob("*"):
            if file.is_file():
                file.chmod(0o444)
        return manifest
    except Exception as error:
        write_json(
            root,
            "failure.json",
            {
                "status": "failed",
                "error": str(error),
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            },
            {**limits, "max_file_bytes": 65536},
        )
        raise
