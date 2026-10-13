"""扩展概览：允许训练快照上的有界展示，完整类型描述另存并绑定哈希。"""

import csv
import hashlib
import json
import math
from array import array
from collections import Counter
from pathlib import Path

from .data_v3 import ESCAPE_PREFIX, MISSING_TOKEN, decode_cell, validate_features
from .dataset_v3 import checked_file, read_json
from .limits import validate_limits
from .profile import numeric
from .protocol_v2 import fields, validate_protocol_v2


def profile_v2(request):
    fields(
        request,
        [
            "version",
            "request_id",
            "protocol",
            "input",
            "feature_schema",
            "identity",
            "limits",
        ],
    )
    if request["version"] != 2 or not isinstance(request["request_id"], str):
        raise ValueError("Invalid profile request")
    protocol = validate_protocol_v2(request["protocol"])
    limits = validate_limits(request["limits"])
    source, schema_ref = request["input"], request["feature_schema"]
    path = Path(source["path"])
    checked_file(path.parent, {**source, "path": path.name}, path.name, limits)
    schema_path = Path(schema_ref["path"])
    checked_file(
        schema_path.parent,
        {**schema_ref, "path": schema_path.name},
        schema_path.name,
        limits,
    )
    schema = read_json(
        schema_path, min(limits["max_file_bytes"], limits["max_memory_bytes"] // 8)
    )
    fields(schema, ["version", "encoding", "missing_token", "escape_prefix", "columns"])
    feature_schema = validate_features(schema["columns"])
    if (
        [c["name"] for c in feature_schema] != protocol["feature_columns"]
        or schema["encoding"] != "escaped-null-v1"
        or schema["version"] != 1
        or schema["missing_token"] != MISSING_TOKEN
        or schema["escape_prefix"] != ESCAPE_PREFIX
    ):
        raise ValueError("Profile feature schema mismatch")
    targets = {t["name"]: t for t in protocol["targets"]}
    names = [protocol["id_column"], *targets, *protocol["feature_columns"]]
    displayed = names[:128]
    # 所有目标都在完整协议中保存；128 列仅限制展示，不删数据列。
    stats = {
        name: {"missing": 0, "counts": Counter(), "numbers": array("d"), "failures": 0}
        for name in displayed
    }
    ids, retained, count = [], 0, 0
    previous = csv.field_size_limit(limits["max_field_bytes"])
    try:
        with path.open(newline="") as stream:
            reader = csv.DictReader(stream)
            columns = reader.fieldnames
            if (
                columns
                != [protocol["id_column"], *protocol["feature_columns"], *targets]
                or len(columns) > limits["max_columns"]
            ):
                raise ValueError("Profile snapshot columns mismatch")
            for row in reader:
                if None in row or None in row.values():
                    raise ValueError("Invalid profile row")
                ids.append(row[protocol["id_column"]])
                count += 1
                retained += 128 + len(ids[-1].encode()) * 4
                if any(
                    len(value.encode()) > limits["max_field_bytes"]
                    for value in row.values()
                ):
                    raise ValueError("Profile field limit exceeded")
                for name, stat in stats.items():
                    value = (
                        decode_cell(row[name])
                        if name in protocol["feature_columns"]
                        else row[name]
                    )
                    if value is None:
                        stat["missing"] += 1
                        continue
                    if value not in stat["counts"]:
                        retained += 160 + len(value.encode()) * 4
                    stat["counts"][value] += 1
                    parsed = numeric(value)
                    if parsed is None:
                        stat["failures"] += 1
                    else:
                        stat["numbers"].append(parsed)
                        retained += 8
                if (
                    count > limits["max_rows"]
                    or retained * 4 > limits["max_memory_bytes"]
                ):
                    raise ValueError("Profile row/memory limit exceeded")
    finally:
        csv.field_size_limit(previous)
    if not ids or any(not value.strip() for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("Invalid profile membership")
    identity = request["identity"]
    fields(
        identity,
        [
            "train_sha256",
            "members_sha256",
            "split_sha256",
            "protocol_sha256",
            "feature_schema_sha256",
            "snapshot_sha256",
        ],
    )
    import re

    if any(
        not isinstance(v, str) or re.fullmatch("[a-f0-9]{64}", v) is None
        for v in identity.values()
    ):
        raise ValueError("Invalid profile identity")
    members_hash = hashlib.sha256(
        json.dumps(ids, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    if (
        identity["members_sha256"] != members_hash
        or identity["protocol_sha256"] != protocol["protocol_sha256"]
        or identity["snapshot_sha256"] != source["sha256"]
        or identity["feature_schema_sha256"] != schema_ref["sha256"]
    ):
        raise ValueError("Profile identity mismatch")
    result = []
    kinds = {feature["name"]: feature["kind"] for feature in feature_schema}
    for name, stat in stats.items():
        categorical = (
            name == protocol["id_column"]
            or name in targets
            and protocol["kind"] != "regression"
            or name in kinds
            and kinds[name] != "numeric"
        )
        frequencies = sorted(
            stat["counts"].items(), key=lambda item: (-item[1], item[0])
        )
        is_numeric = bool(frequencies) and not stat["failures"] and not categorical
        quantiles = None
        if is_numeric:
            ordered = sorted(stat["numbers"])
            quantiles = []
            for q in [0, 0.25, 0.5, 0.75, 1]:
                position = q * (len(ordered) - 1)
                lo, hi = math.floor(position), math.ceil(position)
                quantiles.append(
                    ordered[lo] * (1 - (position - lo)) + ordered[hi] * (position - lo)
                )
        result.append(
            {
                "name": name[:256],
                "omitted_name_characters": max(0, len(name) - 256),
                "source_index": columns.index(name),
                "role": "id"
                if name == protocol["id_column"]
                else "target"
                if name in targets
                else "feature",
                "type": "numeric" if is_numeric else "categorical",
                "missing": stat["missing"],
                "unique": len(frequencies),
                "numeric_parse_failures": stat["failures"],
                "quantiles": quantiles,
                "categories": [
                    {
                        "value": value[:128],
                        "count": frequency,
                        "omitted_characters": max(0, len(value) - 128),
                    }
                    for value, frequency in frequencies[:10]
                ],
                "omitted_categories": max(0, len(frequencies) - 10),
            }
        )
    return {
        "generator": "basic-profile-v2",
        "identity": identity,
        "rows": count,
        "column_count": len(names),
        "missing_policy": "escaped-null-v1",
        "limits": {"columns": 128, "category_values": 10, "text_characters": 128},
        "columns": result,
        "omitted_columns": len(names) - len(result),
        "targets": protocol["targets"],
        "full_feature_schema": {**schema_ref, "path": "basic-profile/features.json"},
    }


if __name__ == "__main__":
    import sys

    request = {}
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Profile request too large")
        request = json.loads(raw)
        result = {"ok": True, "profile": profile_v2(request)}
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
