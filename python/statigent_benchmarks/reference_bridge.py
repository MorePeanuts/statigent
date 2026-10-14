"""固定上游参考的受信评分入口；参考值不会进入智能体输入。"""

import json
import math
import sys
from pathlib import Path

from statigent_modeling.protocol_v2 import fields

from .references import check_dependencies, read_references


def evaluate(request):
    fields(
        request, ["version", "request_id", "data_root", "task_id", "direction", "score"]
    )
    if type(request["version"]) is not int or request["version"] != 1:
        raise ValueError("Invalid reference request")
    dependencies = check_dependencies()
    root = Path(request["data_root"])
    manifest = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "src/evaluation/benchmarks/modeling/dsbench-references.json"
        ).read_text()
    )
    archive = root / manifest["archive"]["path"]
    if archive.resolve() != archive:
        raise ValueError("Reference path must be canonical")
    references = read_references(
        archive,
        manifest["archive"]["sha256"],
        request["task_id"],
        request["direction"],
        manifest["members"],
    )
    value = request["score"]
    if value is not None and (
        type(value) not in (float, int) or not math.isfinite(value)
    ):
        raise ValueError("Invalid native value")
    return {
        "rpg": None if value is None else references.rpg(value),
        "reference_identity": {
            "archive_sha256": manifest["archive"]["sha256"],
            "task_id": request["task_id"],
            "code_commit": manifest["commit"],
        },
        "dependencies": dependencies,
    }


if __name__ == "__main__":
    request = {}
    try:
        raw = sys.stdin.buffer.read(1024**2 + 1)
        if len(raw) > 1024**2:
            raise ValueError("Reference request limit")
        request = json.loads(raw)
        result = {"ok": True, "result": evaluate(request)}
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
