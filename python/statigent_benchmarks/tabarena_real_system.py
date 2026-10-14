"""显式小型真实 r0f0 system 验收：本次拟合、两次预测、主环境与官方评分。"""

import argparse
import csv
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

from statigent_modeling.data_v3 import decode_cell, file_descriptor
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.protocol_v2 import prediction_columns_v2
from statigent_modeling.scoring_v2 import read_table

from .official_predictions import compare
from .tabarena_system import StatigentSystem


def verify(prepared, config, runs):
    import pandas as pd
    from autogluon.core.metrics import get_metric

    start = time.monotonic()
    dataset = load_dataset(prepared)
    source, protocol, limits = (
        dataset["provenance"],
        dataset["protocol"],
        dataset["limits"],
    )
    if (
        source.get("benchmark") != "tabarena-lite"
        or source.get("outer_split") != "openml-r0f0"
    ):
        raise ValueError("Expected prepared TabArena r0f0")
    if config.get("mode") != "deterministic":
        raise ValueError("Real system verification only accepts deterministic mode")
    target = protocol["targets"][0]
    schema = json.loads((prepared / dataset["feature_schema"]["path"]).read_text())
    members = {"training": {}, "prediction": {}}
    with (prepared / dataset["evaluator"]["source_rows"]["path"]).open() as stream:
        for line in stream:
            row = json.loads(line)
            members[row["partition"]][row["id"]] = row["source_row"]

    def frame(reference, partition):
        columns, rows = read_table(
            {**reference, "path": str(prepared / reference["path"])},
            {**limits, "max_memory_bytes": limits["max_memory_bytes"] // 8},
        )
        decoded = [
            {c: decode_cell(v) for c, v in zip(columns, row, strict=True)}
            for row in rows
        ]
        ids = [row[protocol["id_column"]] for row in decoded]
        data = pd.DataFrame(
            decoded, index=[members[partition][identity] for identity in ids]
        )
        for feature in schema["columns"]:
            if feature["kind"] == "numeric":
                data[feature["name"]] = pd.to_numeric(data[feature["name"]])
        return ids, data

    train_ids, training = frame(dataset["training"], "training")
    test_ids, testing = frame(dataset["prediction"], "prediction")
    if (
        set(training.index) & set(testing.index)
        or set(train_ids) != set(members["training"])
        or set(test_ids) != set(members["prediction"])
    ):
        raise ValueError("System member mapping mismatch")
    kind = protocol["kind"]
    if kind == "regression":
        y = pd.to_numeric(training[target["name"]])
    else:
        original = {
            item["canonical"]: item["value"] for item in source["original_classes"]
        }
        y = training[target["name"]].map(original)
        if y.isna().any():
            raise ValueError("Unknown system training label")
    X, test_x = (
        training[protocol["feature_columns"]],
        testing[protocol["feature_columns"]],
    )
    config = {**config, "seed": dataset["seed"]}
    model = StatigentSystem(
        **config,
        run_root=runs,
        problem_type=kind,
        eval_metric=get_metric(
            {"regression": "rmse", "binary": "roc_auc", "multiclass": "log_loss"}[kind],
            kind,
        ),
        validation_metadata={"target_name": target["name"]},
        fit_kwargs={"num_cpus": 1, "num_gpus": 0, "memory_limit": 2, "time_limit": 300},
    )
    report = {
        "version": 1,
        "scope": "official-system-real-r0f0",
        "status": "failed",
        "task_id": source["task_id"],
        "source_dataset_sha256": dataset["dataset_sha256"],
        "openml": source["openml"],
        "seed": dataset["seed"],
        "live_llm_calls": 0,
        "research_experiment": False,
    }
    try:
        model._split_seed = dataset["seed"]
        source_hash = hashlib.sha256(
            X.to_csv().encode() + y.to_csv().encode() + test_x.to_csv().encode()
        ).hexdigest()
        (model.directory / "input-members.json").write_text(
            json.dumps(
                {
                    "source_rows": dataset["evaluator"]["source_rows"],
                    "training": list(X.index),
                    "prediction": list(test_x.index),
                    "prepared_dataset_sha256": dataset["dataset_sha256"],
                    "frame_sha256": source_hash,
                }
            )
        )
        model.fit(X, y)
        frozen = model.frozen_root / "frozen/model.json"
        frozen_hash = hashlib.sha256(frozen.read_bytes()).hexdigest()
        first = (
            model.predict(test_x)
            if kind == "regression"
            else model.predict_proba(test_x)
        )
        second = (
            model.predict(test_x)
            if kind == "regression"
            else model.predict_proba(test_x)
        )
        if (
            not first.equals(second)
            or not first.index.equals(test_x.index)
            or hashlib.sha256(frozen.read_bytes()).hexdigest() != frozen_hash
        ):
            raise ValueError("System frozen prediction reproduction mismatch")
        if (
            hashlib.sha256(
                X.to_csv().encode() + y.to_csv().encode() + test_x.to_csv().encode()
            ).hexdigest()
            != source_hash
        ):
            raise ValueError("System input changed")
        path = model.directory / "canonical-predictions.csv"
        with path.open("x", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(prediction_columns_v2(protocol))
            for index, identity in enumerate(test_ids):
                if kind == "regression":
                    writer.writerow([identity, float(first.iloc[index])])
                else:
                    ordered = [original[label] for label in target["classes"]]
                    if list(first.columns) != ordered:
                        raise ValueError("System returned class order mismatch")
                    probabilities = [
                        float(first.iloc[index][label]) for label in ordered
                    ]
                    label = target["classes"][
                        max(range(len(ordered)), key=lambda i: probabilities[i])
                    ]
                    writer.writerow([identity, label, *probabilities])
        prediction = {
            **file_descriptor(model.directory, path.name, limits),
            "path": str(path),
        }
        labels = dataset["evaluator"]["labels"]
        request = dict(
            version=2,
            request_id="real-system",
            protocol=protocol,
            evaluation_id=hashlib.sha256(
                (dataset["dataset_sha256"] + prediction["sha256"]).encode()
            ).hexdigest(),
            partition="test",
            labels={**labels, "path": str(prepared / labels["path"])},
            predictions=prediction,
            limits=limits,
        )
        repository = Path(__file__).resolve().parents[2]
        environment = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "UV_CACHE_DIR")
            if key in os.environ
        }
        environment["PYTHONPATH"] = str(repository / "python")
        result = subprocess.run(
            [
                "uv",
                "run",
                "--offline",
                "--frozen",
                "--no-sync",
                "--project",
                str(repository),
                "python",
                "-m",
                "statigent_modeling.scoring",
            ],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            env=environment,
            cwd=repository,
            timeout=60,
        )
        if result.returncode != 0 or len(result.stdout.encode()) > 1024**2:
            raise ValueError(f"Main scoring process failed: {result.stderr[:4096]}")
        native = json.loads(result.stdout)
        if not native["ok"]:
            raise ValueError(f"Main scoring failed: {native}")
        official = compare(
            dict(
                version=1,
                request_id="official",
                prepared_root=str(prepared),
                dataset_sha256=dataset["dataset_sha256"],
                predictions=prediction,
                native_score=native["score"]["value"],
            )
        )
        report.update(
            status="passed",
            directory=str(model.directory),
            fit=model.fit_response,
            prediction_records=model.prediction_records,
            native_score=native["score"],
            official=official,
            reproduction="two-independent-predict-calls-identical",
            frozen_sha256=frozen_hash,
        )
    except Exception as error:
        report["error"] = str(error)
    finally:
        try:
            model.cleanup()
        except Exception as error:
            report.update(status="failed", cleanup_error=str(error))
        report["elapsed_ms"] = (time.monotonic() - start) * 1000
        destination = model.directory / "real-system-verification.json"
        destination.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False))
    return {
        "status": report["status"],
        "report": str(destination),
        "task_id": source["task_id"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--runs", type=Path, required=True)
    args = parser.parse_args()
    result = verify(
        args.prepared.resolve(),
        json.loads(args.config.read_text()),
        args.runs.resolve(),
    )
    print(json.dumps(result))
    if result["status"] != "passed":
        raise SystemExit(1)
