"""准备清单的可信预检；逐行检查数据，既不执行模型也不加载整张特征表。"""

import csv
import hashlib
import json
import re
from pathlib import Path

from .data_v3 import ESCAPE_PREFIX, MISSING_TOKEN, split_rows, validate_features
from .limits import validate_limits
from .protocol_v2 import digest, fields, validate_protocol_v2


def read_json(path, limit):
    if path.stat().st_size > limit:
        raise ValueError("Metadata memory/file limit exceeded")
    return json.loads(path.read_text())


def validate_reference(ref, expected, limits):
    fields(ref, ["path", "bytes", "sha256"])
    if (
        ref["path"] != expected
        or not isinstance(ref["sha256"], str)
        or re.fullmatch(r"[a-f0-9]{64}", ref["sha256"]) is None
    ):
        raise ValueError("Invalid partition file reference")
    if (
        type(ref["bytes"]) is not int
        or not 0 <= ref["bytes"] <= limits["max_file_bytes"]
    ):
        raise ValueError("Partition file size mismatch/limit exceeded")


def checked_file(root, ref, expected, limits):
    validate_reference(ref, expected, limits)
    path = root / ref["path"]
    if path.resolve() != path or path.is_symlink() or not path.is_file():
        raise ValueError("Escaping/non-regular partition file")
    if (
        type(ref["bytes"]) is not int
        or not 0 <= ref["bytes"] <= limits["max_file_bytes"]
        or path.stat().st_size != ref["bytes"]
    ):
        raise ValueError("Partition file size mismatch/limit exceeded")
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != ref["sha256"]:
            raise ValueError("Partition file hash mismatch")
    return path


def load_dataset(root: Path, limits_override=None, access="complete"):
    if access not in ("complete", "training"):
        raise ValueError("Unknown dataset access mode")
    root = root.resolve(strict=True)
    # 初始清单上限不随不可信清单自我声明膨胀。
    manifest = read_json(root / "dataset.json", 16 * 1024 * 1024)
    fields(
        manifest,
        [
            "schema_version",
            "protocol",
            "seed",
            "limits",
            "excluded_columns",
            "training",
            "prediction",
            "evaluator",
            "feature_schema",
            "public_context",
            "split",
            "rows",
            "provenance",
            "preparation",
            "dataset_sha256",
        ],
    )
    if type(manifest["schema_version"]) is not int or manifest["schema_version"] != 3:
        raise ValueError("Invalid dataset version")
    if (
        digest({k: v for k, v in manifest.items() if k != "dataset_sha256"})
        != manifest["dataset_sha256"]
    ):
        raise ValueError("Dataset manifest hash mismatch")
    protocol = validate_protocol_v2(manifest["protocol"])
    limits = validate_limits(manifest["limits"])
    if limits_override is not None:
        override = validate_limits(limits_override)
        limits = {key: min(value, override[key]) for key, value in limits.items()}
    metadata_limit = min(limits["max_file_bytes"], limits["max_memory_bytes"] // 8)
    seed = manifest["seed"]
    if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
        raise ValueError("Invalid dataset seed")
    excluded = manifest["excluded_columns"]
    if (
        not isinstance(excluded, list)
        or not all(isinstance(v, str) and v.strip() for v in excluded)
        or len(set(excluded)) != len(excluded)
        or set(excluded) & set(protocol["feature_columns"])
    ):
        raise ValueError("Invalid feature exclusions")
    fields(manifest["evaluator"], ["labels", "source_rows"])
    fields(manifest["rows"], ["training", "prediction"])
    fields(manifest["split"], ["file", "method", "train_rows", "validation_rows"])
    fields(manifest["preparation"], ["created_at", "elapsed_ms", "reused_from"])
    from datetime import datetime

    datetime.fromisoformat(manifest["preparation"]["created_at"])
    if (
        type(manifest["preparation"]["elapsed_ms"]) is not int
        or manifest["preparation"]["elapsed_ms"] < 0
        or manifest["preparation"]["reused_from"] is not None
        or not isinstance(manifest["provenance"], dict)
    ):
        raise ValueError("Invalid preparation provenance")
    schema_path = checked_file(
        root, manifest["feature_schema"], "search/features.json", limits
    )
    context_paths = set()
    for context in manifest["public_context"]:
        if (
            context["path"] not in ("search/task.txt", "search/adaptation.json")
            or context["path"] in context_paths
        ):
            raise ValueError("Invalid public context file")
        checked_file(root, context, context["path"], limits)
        context_paths.add(context["path"])
    schema = read_json(schema_path, metadata_limit)
    fields(schema, ["version", "encoding", "missing_token", "escape_prefix", "columns"])
    if (
        schema["version"] != 1
        or schema["encoding"] != "escaped-null-v1"
        or schema["missing_token"] != MISSING_TOKEN
        or schema["escape_prefix"] != ESCAPE_PREFIX
        or [f["name"] for f in validate_features(schema["columns"])]
        != protocol["feature_columns"]
    ):
        raise ValueError("Feature schema mismatch")
    split_path = checked_file(
        root, manifest["split"]["file"], "search/split.json", limits
    )
    split = read_json(split_path, metadata_limit)
    fields(split, ["version", "method", "seed", "train", "validation", "sha256"])
    targets = [t["name"] for t in protocol["targets"]]
    target_values = {name: [] for name in targets}
    seen, ids = set(), {"training": [], "prediction": []}
    retained_bytes = 0

    def scan(ref, relative, columns, partition):
        nonlocal retained_bytes
        path = checked_file(root, ref, relative, limits)
        old_limit = csv.field_size_limit(limits["max_field_bytes"])
        try:
            with path.open(newline="", encoding="utf-8") as stream:
                reader = csv.reader(stream)
                if next(reader) != columns or len(columns) > limits["max_columns"]:
                    raise ValueError("Partition columns/target order mismatch")
                members = []
                for row in reader:
                    if len(row) != len(columns) or any(
                        len(v.encode()) > limits["max_field_bytes"] for v in row
                    ):
                        raise ValueError("Partition row/field limit exceeded")
                    identity = row[0]
                    if not identity.strip() or (
                        partition != "labels" and identity in seen
                    ):
                        raise ValueError("Duplicate/invalid sample identity")
                    members.append(identity)
                    retained_bytes += 256 + 8 * len(identity.encode())
                    if (
                        len(members) > limits["max_rows"]
                        or retained_bytes * 3 > limits["max_memory_bytes"]
                    ):
                        raise ValueError("Partition row/memory limit exceeded")
                    if partition != "labels":
                        seen.add(identity)
                    if partition in ("training", "labels"):
                        for target, value in zip(
                            protocol["targets"], row[-len(targets) :], strict=True
                        ):
                            import math

                            if (
                                not value.strip()
                                or (
                                    protocol["kind"] == "regression"
                                    and not math.isfinite(float(value))
                                )
                                or (
                                    protocol["kind"] != "regression"
                                    and value not in target["classes"]
                                )
                            ):
                                raise ValueError(
                                    f"Invalid target value: {target['name']}"
                                )
                            if partition == "training":
                                target_values[target["name"]].append(value)
                                retained_bytes += 128 + 4 * len(value.encode())
                if not members:
                    raise ValueError("Empty partition")
                return members
        finally:
            csv.field_size_limit(old_limit)

    ids["training"] = scan(
        manifest["training"],
        "search/train.csv",
        [protocol["id_column"], *protocol["feature_columns"], *targets],
        "training",
    )
    if manifest["prediction"] is not None:
        validate_reference(manifest["prediction"], "final-prediction/test.csv", limits)
    if manifest["evaluator"]["labels"] is not None:
        validate_reference(
            manifest["evaluator"]["labels"], "evaluator/labels.csv", limits
        )
    validate_reference(
        manifest["evaluator"]["source_rows"], "evaluator/source-rows.jsonl", limits
    )
    prediction_rows = manifest["rows"]["prediction"]
    if (
        type(prediction_rows) is not int
        or not 0 <= prediction_rows <= limits["max_rows"]
        or (prediction_rows == 0) != (manifest["prediction"] is None)
        or (
            manifest["prediction"] is None
            and manifest["evaluator"]["labels"] is not None
        )
    ):
        raise ValueError("Prediction partition metadata mismatch")
    if access == "complete" and manifest["prediction"] is not None:
        ids["prediction"] = scan(
            manifest["prediction"],
            "final-prediction/test.csv",
            [protocol["id_column"], *protocol["feature_columns"]],
            "prediction",
        )
    for partition in ids:
        if access == "training" and partition == "prediction":
            continue
        if type(manifest["rows"][partition]) is not int or manifest["rows"][
            partition
        ] != len(ids[partition]):
            raise ValueError("Partition row count mismatch")
    if access == "complete" and manifest["evaluator"]["labels"] is not None:
        labels = scan(
            manifest["evaluator"]["labels"],
            "evaluator/labels.csv",
            [protocol["id_column"], *targets],
            "labels",
        )
        if labels != ids["prediction"]:
            raise ValueError("Private label membership/order mismatch")
    expected_split = split_rows(
        ids["training"],
        target_values,
        protocol,
        seed,
        {"train": split["train"], "validation": split["validation"]}
        if split["method"] == "explicit-v1"
        else None,
    )
    if split != expected_split or manifest["split"] != {
        "file": manifest["split"]["file"],
        "method": split["method"],
        "train_rows": len(split["train"]),
        "validation_rows": len(split["validation"]),
    }:
        raise ValueError("Frozen split mismatch")
    if access == "training":
        return manifest
    mapping = checked_file(
        root,
        manifest["evaluator"]["source_rows"],
        "evaluator/source-rows.jsonl",
        limits,
    )
    with mapping.open() as stream:
        for partition, members in ids.items():
            source_rows = set()
            for identity in members:
                line = stream.readline(limits["max_field_bytes"] * 4 + 1024)
                item = json.loads(line)
                fields(item, ["id", "partition", "source_row", "export_id"])
                if (
                    item["id"] != identity
                    or item["partition"] != partition
                    or type(item["source_row"]) is not int
                    or item["source_row"] < 0
                    or item["source_row"] in source_rows
                    or (
                        item["export_id"] is not None
                        and not isinstance(item["export_id"], (str, int, float, bool))
                    )
                ):
                    raise ValueError("Source row mapping mismatch")
                source_rows.add(item["source_row"])
        if stream.read(1):
            raise ValueError("Extra source row mappings")
    return manifest


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--limits", type=json.loads)
    parser.add_argument(
        "--access", choices=["complete", "training"], default="complete"
    )
    args = parser.parse_args()
    print(
        json.dumps(
            load_dataset(args.root, args.limits, args.access), ensure_ascii=False
        )
    )
