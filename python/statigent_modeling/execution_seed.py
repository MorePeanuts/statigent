"""固定外层训练成员，在独立运行目录派生明确种子的内部划分；不读外层数据。"""

import csv
import json
import shutil
import time
from pathlib import Path

from .data_v3 import file_descriptor, split_rows, write_json
from .dataset_v3 import load_dataset, read_json
from .protocol_v2 import digest, fields


def prepare_execution_seed(request):
    fields(
        request,
        [
            "version",
            "request_id",
            "source_root",
            "source_sha256",
            "output_root",
            "seed",
        ],
    )
    if (
        type(request["version"]) is not int
        or request["version"] != 1
        or not isinstance(request["request_id"], str)
        or not 1 <= len(request["request_id"]) <= 128
    ):
        raise ValueError("Invalid seed preparation request")
    seed = request["seed"]
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Invalid model seed")
    started = time.monotonic()
    source = Path(request["source_root"])
    output = Path(request["output_root"])
    if source.resolve() != source or output.resolve() != output:
        raise ValueError("Seed preparation requires canonical paths")
    manifest = load_dataset(source, access="training")
    if manifest["dataset_sha256"] != request["source_sha256"]:
        raise ValueError("Seed preparation source identity mismatch")
    limits, protocol = manifest["limits"], manifest["protocol"]
    ids, values = [], {t["name"]: [] for t in protocol["targets"]}
    retained = 0
    old_limit = csv.field_size_limit(limits["max_field_bytes"])
    try:
        with (source / manifest["training"]["path"]).open(newline="") as stream:
            reader = csv.DictReader(stream)
            for row in reader:
                identity = row[protocol["id_column"]]
                ids.append(identity)
                retained += 128 + 4 * len(identity.encode())
                for name, items in values.items():
                    items.append(row[name])
                    retained += 128 + 4 * len(row[name].encode())
                if retained * 4 > limits["max_memory_bytes"]:
                    raise ValueError("Seed preparation memory limit")
    finally:
        csv.field_size_limit(old_limit)
    split = read_json(
        source / manifest["split"]["file"]["path"],
        min(limits["max_file_bytes"], limits["max_memory_bytes"] // 8),
    )
    derived = split_rows(
        ids,
        values,
        protocol,
        seed,
        {"train": split["train"], "validation": split["validation"]}
        if split["method"] == "explicit-v1"
        else None,
    )
    output.mkdir()
    (output / "search").mkdir()
    for ref in [
        manifest["training"],
        manifest["feature_schema"],
        *manifest["public_context"],
    ]:
        path = output / ref["path"]
        with (source / ref["path"]).open("rb") as src, path.open("xb") as dst:
            shutil.copyfileobj(src, dst, length=1024**2)
        if file_descriptor(output, ref["path"], limits) != ref:
            raise ValueError("Seed preparation copy integrity")
        path.chmod(0o444)
    manifest["seed"] = seed
    manifest["split"] = {
        "file": write_json(output, "search/split.json", derived, limits),
        "method": derived["method"],
        "train_rows": len(derived["train"]),
        "validation_rows": len(derived["validation"]),
    }
    manifest["provenance"] = {
        **manifest["provenance"],
        "execution_seed_source": request["source_sha256"],
        "execution_seed_algorithm": "dataset-seed-v1",
    }
    manifest["dataset_sha256"] = digest(
        {k: v for k, v in manifest.items() if k != "dataset_sha256"}
    )
    write_json(output, "dataset.json", manifest, limits)
    load_dataset(output, access="training")
    receipt = {
        "version": 1,
        "algorithm": "dataset-seed-v1",
        "source_sha256": request["source_sha256"],
        "dataset_sha256": manifest["dataset_sha256"],
        "seed": seed,
        "elapsed_ms": (time.monotonic() - started) * 1000,
        "calls": {"models": 0, "fits": 0},
        "source_preparation": manifest["preparation"],
        "reused_outer_data": True,
    }
    (output / "seed-preparation.json").write_text(json.dumps(receipt))
    for path in [
        output / "dataset.json",
        output / "search/split.json",
        output / "seed-preparation.json",
    ]:
        path.chmod(0o444)
    return {
        "directory": str(output),
        "dataset_sha256": manifest["dataset_sha256"],
        "receipt": receipt,
    }


if __name__ == "__main__":
    import sys

    request = {}
    try:
        raw = sys.stdin.buffer.read(1024**2 + 1)
        if len(raw) > 1024**2:
            raise ValueError("Seed preparation request limit")
        request = json.loads(raw)
        result = {"ok": True, "result": prepare_execution_seed(request)}
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
