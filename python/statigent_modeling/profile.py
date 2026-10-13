"""Bounded descriptive statistics over a host-selected internal training snapshot."""

import hashlib
import json
import math
import re
import sys
from collections import Counter

from statigent_modeling.protocol import validate_protocol
from statigent_modeling.scoring import read_table

VERSION = "basic-profile-v1"
MAX_COLUMNS = 128
MAX_TEXT = 128
TOP_CATEGORIES = 10
NUMERIC = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")


def numeric(value):
    text = value.strip()
    if not NUMERIC.fullmatch(text):
        return None
    number = float(text)
    return number if math.isfinite(number) else None


def summarize(name, values, role, categorical=False):
    present = [v for v in values if v != ""]
    numbers = [numeric(v) for v in present]
    failures = sum(v is None for v in numbers)
    is_numeric = bool(present) and not failures and not categorical
    frequencies = sorted(Counter(present).items(), key=lambda v: (-v[1], v[0]))
    quantiles = None
    if is_numeric:
        ordered = sorted(numbers)

        def quantile(q):
            position = q * (len(ordered) - 1)
            lo, hi = math.floor(position), math.ceil(position)
            # Weighted interpolation avoids overflow of (hi - lo).
            return ordered[lo] * (1 - (position - lo)) + ordered[hi] * (position - lo)

        quantiles = [quantile(q) for q in [0, 0.25, 0.5, 0.75, 1]]
    return {
        "name": name,
        "role": role,
        "type": "numeric" if is_numeric else "categorical",
        "missing": len(values) - len(present),
        "unique": len(frequencies),
        "numeric_parse_failures": failures,
        "quantiles": quantiles,
        "categories": [
            {
                "value": v[:MAX_TEXT],
                "count": n,
                "omitted_characters": max(0, len(v) - MAX_TEXT),
            }
            for v, n in frequencies[:TOP_CATEGORIES]
        ],
        "omitted_categories": max(0, len(frequencies) - TOP_CATEGORIES),
    }


def profile(request):
    if (
        set(request)
        != {
            "version",
            "request_id",
            "protocol",
            "id_column",
            "target",
            "input",
            "identity",
        }
        or request["version"] != 1
    ):
        raise ValueError("Invalid profile request")
    if not isinstance(request["request_id"], str) or not request["request_id"]:
        raise ValueError("Invalid request ID")
    p = validate_protocol(request["protocol"], request["id_column"])
    columns, rows = read_table(request["input"])
    if not rows or len(columns) > MAX_COLUMNS or any(len(c) > 256 for c in columns):
        raise ValueError("Profile row/column limit")
    if request["target"] not in columns or request["id_column"] not in columns:
        raise ValueError("Missing target/ID")
    ids = [r[columns.index(request["id_column"])] for r in rows]
    members = hashlib.sha256(
        json.dumps(ids, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    identity = request["identity"]
    if set(identity) != {
        "train_sha256",
        "members_sha256",
        "split_sha256",
        "protocol_sha256",
    } or any(
        not isinstance(v, str) or not re.fullmatch("[0-9a-f]{64}", v)
        for v in identity.values()
    ):
        raise ValueError("Invalid profile identity")
    if (
        len(set(ids)) != len(ids)
        or members != identity["members_sha256"]
        or p["protocol_sha256"] != identity["protocol_sha256"]
    ):
        raise ValueError("Profile identity mismatch")
    return {
        "generator": VERSION,
        "identity": identity,
        "rows": len(rows),
        "column_count": len(columns),
        "missing_policy": "empty-string-only",
        "limits": {
            "columns": MAX_COLUMNS,
            "category_values": TOP_CATEGORIES,
            "text_characters": MAX_TEXT,
        },
        "columns": [
            summarize(
                c,
                [r[i] for r in rows],
                "target"
                if c == request["target"]
                else "id"
                if c == request["id_column"]
                else "feature",
                c == request["id_column"]
                or (c == request["target"] and p["kind"] != "regression"),
            )
            for i, c in enumerate(columns)
        ],
    }


def main():
    request = {}
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Profile request too large")
        request = json.loads(raw)
        result = {"ok": True, "profile": profile(request)}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:4096]}
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


if __name__ == "__main__":
    main()
