"""受信准备服务：显式生成或只读复用，不调用模型、不训练、不下载。"""

import json
import sys
import time
from pathlib import Path

from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.limits import validate_limits
from statigent_modeling.protocol_v2 import fields

from .prepare_ds import prepare_ds, verify_sources
from .prepare_tab import prepare_tab, tab_sources


def prepare(request):
    fields(
        request,
        [
            "version",
            "request_id",
            "operation",
            "task",
            "source_root",
            "dataset_root",
            "seed",
            "limits",
        ],
    )
    if request["version"] != 1 or request["operation"] not in ("prepare", "reuse"):
        raise ValueError("Invalid preparation request")
    if not isinstance(request["request_id"], str) or not request["request_id"]:
        raise ValueError("Invalid preparation request ID")
    limits = validate_limits(request["limits"])
    source = Path(request["source_root"]).resolve(strict=True)
    dataset_root = Path(request["dataset_root"])
    if not dataset_root.is_absolute() or dataset_root.resolve() != dataset_root:
        raise ValueError("Invalid dataset path")
    if dataset_root.is_relative_to(source):
        raise ValueError("Preparation output must be outside original benchmark tree")
    task = request["task"]
    benchmark = task["benchmark"]
    if benchmark not in ("dsbench-modeling", "tabarena-lite"):
        raise ValueError("Unsupported preparation benchmark")
    started = time.monotonic()
    if request["operation"] == "reuse":
        manifest = load_dataset(dataset_root, limits)
        provenance = manifest["provenance"]
        if (
            manifest["seed"] != request["seed"]
            or manifest["limits"] != limits
            or any(
                provenance.get(key) != task[key]
                for key in (
                    "benchmark",
                    "task_id",
                    "source_revision",
                    "code_revision",
                    "outer_split",
                )
            )
            or provenance.get("sources") != task["files"]
        ):
            raise ValueError("Prepared dataset/config/source identity mismatch")
        if benchmark == "dsbench-modeling":
            if provenance.get("scorer") != task["protocol"]["scorer"]:
                raise ValueError("Prepared scorer identity mismatch")
            verify_sources(source, task)
        else:
            if provenance.get("openml") != task["openml"]:
                raise ValueError("Prepared OpenML identity mismatch")
            tab_sources(source, task)
    else:
        if dataset_root.exists():
            raise FileExistsError("Preparation output already exists")
        adapter = prepare_ds if benchmark == "dsbench-modeling" else prepare_tab
        manifest = adapter(
            source, task, dataset_root, seed=request["seed"], limits=limits
        )
    return {
        "operation": request["operation"],
        "dataset": manifest,
        "dataset_root": str(dataset_root),
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "reused_from": str(dataset_root) if request["operation"] == "reuse" else None,
        "original_preparation": manifest["preparation"],
        "llm_calls": 0,
        "fits": 0,
        "downloads": 0,
    }


def main():
    request = {}
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Preparation request too large")
        request = json.loads(raw)
        result = {"ok": True, "result": prepare(request)}
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
            ensure_ascii=False,
            allow_nan=False,
        )
    )


if __name__ == "__main__":
    main()
