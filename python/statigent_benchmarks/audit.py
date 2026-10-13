"""全候选只读审计：来源、列和固定成员；不导入训练/模型供应商代码。"""

import csv
import json
import time
from pathlib import Path

from .ds_catalog import inspect_csv, sha256
from .references import read_references


def source_path(root: Path, relative: str) -> Path:
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f"Missing/unsafe source: {relative}")
    return path


def check_split(path: Path, rows: int) -> dict:
    seen = set()
    counts = {"TRAIN": 0, "TEST": 0}
    with path.open(newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ["type", "rowid", "repeat", "fold"]:
            raise ValueError("Invalid split columns")
        for row in reader:
            if row["repeat"] != "0" or row["fold"] != "0" or row["type"] not in counts:
                raise ValueError("Split is not r0f0 TRAIN/TEST")
            identity = int(row["rowid"])
            if identity < 0 or identity >= rows or identity in seen:
                raise ValueError("Duplicate/intersecting/out-of-range split member")
            seen.add(identity)
            counts[row["type"]] += 1
    if len(seen) != rows or not all(counts.values()):
        raise ValueError("Incomplete/empty split")
    return {"train_rows": counts["TRAIN"], "test_rows": counts["TEST"]}


def audit_task(root: Path, task: dict, references: dict) -> dict:
    started = time.monotonic()
    problems = []
    result = {
        "benchmark": task["benchmark"],
        "task_id": task["task_id"],
        "source_revision": task["source_revision"],
        "code_revision": task["code_revision"],
        "source_status": "passed",
        "structure_status": "not_run",
        "research": task["research"],
        "adaptation": task["adaptation"],
        "acceptance": task["acceptance"],
        "issues": task["issues"],
        "problems": problems,
    }
    files = list(task["files"])
    if task["protocol"]:
        files.append(task["protocol"]["scorer"])
    for descriptor in files:
        try:
            path = source_path(root, descriptor["path"])
            if (
                path.stat().st_size != descriptor["bytes"]
                or sha256(path) != descriptor["sha256"]
            ):
                raise ValueError(f"Source size/hash mismatch: {descriptor['path']}")
        except (ValueError, OSError) as error:
            problems.append(str(error))
            result["source_status"] = "failed"
    if not problems:
        try:
            if task["benchmark"] == "dsbench-modeling":
                protocol = task["protocol"]
                if protocol is None:
                    raise ValueError("Missing DSBench protocol")
                base = root / "dsbench/modeling/public" / task["task_id"]
                column = protocol["identity"]["column"] or ""
                train = inspect_csv(base / "train.csv", column)
                test = inspect_csv(base / "test.csv", column)
                private = (
                    root
                    / "dsbench/modeling/private"
                    / task["task_id"]
                    / "test_answer.csv"
                )
                labels = inspect_csv(private, column)
                if labels["rows"] != test["rows"] or not set(
                    protocol["targets"]
                ) <= set(labels["columns"]):
                    raise ValueError("Private label shape mismatch")
                if column and not (
                    train["valid_id"] and test["valid_id"] and labels["valid_id"]
                ):
                    raise ValueError("Invalid source identity")
                forbidden = set(protocol["targets"] + protocol["excluded_columns"])
                features = set(protocol["feature_columns"])
                if features & forbidden or features != set(test["columns"]) - {column}:
                    raise ValueError("Feature whitelist mismatch")
                read_references(
                    root / references["archive"]["path"],
                    references["archive"]["sha256"],
                    task["task_id"],
                    protocol["metric"]["direction"],
                    references["members"],
                )
                result["structure_status"] = "passed"
                result["shape"] = {
                    "train_rows": train["rows"],
                    "test_rows": test["rows"],
                    "features": len(features),
                }
            else:
                base = root / "tabarena-lite/raw" / task["task_id"]
                metadata = json.loads((base / "lite-metadata.json").read_text())
                dataset = json.loads((base / "dataset.json").read_text())[
                    "data_set_description"
                ]
                if (
                    str(dataset["id"]) != task["openml"]["dataset_id"]
                    or int(dataset["version"]) != task["openml"]["version"]
                ):
                    raise ValueError("OpenML dataset version mismatch")
                if metadata["task_id_str"] != task["task_id"]:
                    raise ValueError("OpenML task mismatch")
                shape = check_split(
                    base / "splits-r0-f0.csv", int(float(metadata["num_instances"]))
                )
                shape["features"] = int(metadata["num_features"])
                result["shape"] = shape
                result["structure_status"] = "metadata_and_split_passed"
                result["raw_decode"] = "not_run"
                result["protocol_status"] = (
                    "blocked" if task["protocol"] is None else "declared"
                )
        except (ValueError, OSError, KeyError) as error:
            result["structure_status"] = "failed"
            problems.append(str(error))
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result


def audit(root: Path, catalog: dict, references: dict) -> dict:
    started = time.monotonic()
    results = [audit_task(root, task, references) for task in catalog["tasks"]]
    return {
        "schema_version": 1,
        "operation": "modeling-candidate-audit",
        "status": "incomplete" if any(r["problems"] for r in results) else "complete",
        "scope": "source-and-published-structure",
        "llm_calls": 0,
        "fits": 0,
        "downloads": 0,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "tasks": results,
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--references", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            audit(
                args.root,
                json.loads(args.catalog.read_text()),
                json.loads(args.references.read_text()),
            ),
            ensure_ascii=False,
        )
    )
