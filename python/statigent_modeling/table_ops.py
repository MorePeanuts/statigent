"""按冻结成员物化允许列；只保留行偏移索引，避免复制完整特征表。"""

import csv
import hashlib
import json
from pathlib import Path

from .dataset_v3 import checked_file, read_json
from .limits import validate_limits
from .protocol_v2 import fields


def select_table(source, destination: Path, columns, members, limits):
    limits = validate_limits(limits)
    path = Path(source["path"])
    checked_file(path.parent, {**source, "path": path.name}, path.name, limits)
    if not columns or len(set(columns)) != len(columns):
        raise ValueError("Invalid selected columns")
    if members is not None and (
        not isinstance(members, list)
        or not members
        or not all(isinstance(v, str) and v.strip() for v in members)
        or len(set(members)) != len(members)
    ):
        raise ValueError("Invalid requested members")
    previous = csv.field_size_limit(limits["max_field_bytes"])
    try:
        # readline 迭代保留 TextIO 的 seek cookie，兼容字段内换行及 UTF-8。
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.reader(iter(stream.readline, ""))
            header = next(reader)
            if (
                len(set(header)) != len(header)
                or len(header) > limits["max_columns"]
                or not set(columns) <= set(header)
                or columns[0] != header[0]
            ):
                raise ValueError("Invalid source/selected columns")
            positions = [header.index(name) for name in columns]
            offsets, retained = {}, 0
            while True:
                offset = stream.tell()
                row = next(reader, None)
                if row is None:
                    break
                if len(row) != len(header) or any(
                    len(v.encode()) > limits["max_field_bytes"] for v in row
                ):
                    raise ValueError("Source row/field limit exceeded")
                identity = row[0]
                if not identity.strip() or identity in offsets:
                    raise ValueError("Duplicate/invalid source identity")
                offsets[identity] = offset
                retained += 256 + len(identity.encode()) * 4
                if (
                    len(offsets) > limits["max_rows"]
                    or retained * 4 > limits["max_memory_bytes"]
                ):
                    raise ValueError("Selection index row/memory limit exceeded")
            selected = list(offsets) if members is None else members
            if not selected or any(identity not in offsets for identity in selected):
                raise ValueError("Missing selected member")
            with destination.open("x", newline="", encoding="utf-8") as output:
                writer = csv.writer(output)
                writer.writerow(columns)
                for identity in selected:
                    stream.seek(offsets[identity])
                    row = next(csv.reader(iter(stream.readline, "")))
                    if row[0] != identity:
                        raise ValueError("Source changed during selection")
                    writer.writerow([row[index] for index in positions])
                    if output.tell() > limits["max_file_bytes"]:
                        raise ValueError("Selection output file limit exceeded")
        with destination.open("rb") as result:
            digest = hashlib.file_digest(result, "sha256").hexdigest()
        return {
            "path": str(destination.resolve()),
            "bytes": destination.stat().st_size,
            "sha256": digest,
            "rows": len(selected),
            "members_sha256": hashlib.sha256(
                json.dumps(selected, ensure_ascii=False, separators=(",", ":")).encode()
            ).hexdigest(),
        }
    finally:
        csv.field_size_limit(previous)


def handle(request):
    fields(
        request, ["version", "request_id", "source", "output", "selection", "limits"]
    )
    if request["version"] != 2 or not isinstance(request["request_id"], str):
        raise ValueError("Invalid selection request")
    limits = validate_limits(request["limits"])
    ref = request["selection"]
    path = Path(ref["path"])
    checked_file(path.parent, {**ref, "path": path.name}, path.name, limits)
    selection = read_json(
        path, min(limits["max_file_bytes"], limits["max_memory_bytes"] // 8)
    )
    fields(selection, ["columns", "members"])
    destination = Path(request["output"])
    if not destination.is_absolute() or destination.resolve() != destination:
        raise ValueError("Invalid selection output")
    return select_table(
        request["source"],
        destination,
        selection["columns"],
        selection["members"],
        limits,
    )


if __name__ == "__main__":
    import sys

    request = {}
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Selection request too large")
        request = json.loads(raw)
        result = {"ok": True, "result": handle(request)}
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
