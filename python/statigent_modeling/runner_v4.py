"""V2 目标在现有隔离 runner 中的计算；宿主不得调用模型反序列化。"""

import csv
import json

import joblib
import numpy as np
import pandas as pd

from .data_v3 import ESCAPE_PREFIX, MISSING_TOKEN, decode_cell, validate_features
from .dataset_v3 import checked_file, read_json
from .limits import validate_limits
from .protocol import class_indices, probabilities
from .protocol_v2 import fields, prediction_columns_v2, validate_protocol_v2


def load_stage_data(base, config, stage):
    protocol, limits = config["protocol"], config["limits"]
    schema_path = checked_file(base, config["feature_schema"], "features.json", limits)
    schema = read_json(
        schema_path, min(limits["max_file_bytes"], limits["max_memory_bytes"] // 8)
    )
    fields(schema, ["version", "encoding", "missing_token", "escape_prefix", "columns"])
    if (
        schema["version"] != 1
        or schema["encoding"] != "escaped-null-v1"
        or schema["missing_token"] != MISSING_TOKEN
        or schema["escape_prefix"] != ESCAPE_PREFIX
        or [c["name"] for c in validate_features(schema["columns"])]
        != protocol["feature_columns"]
    ):
        raise ValueError("Stage feature schema mismatch")
    path = checked_file(base, config["data"], "data.csv", limits)
    targets = [target["name"] for target in protocol["targets"]]
    expected = [
        protocol["id_column"],
        *protocol["feature_columns"],
        *(targets if stage == "fit" else []),
    ]
    with path.open(newline="") as stream:
        if next(csv.reader(stream)) != expected:
            raise ValueError("Stage columns/target order mismatch")
    if len(expected) > limits["max_columns"]:
        raise ValueError("Stage column limit exceeded")
    parts, count = [], 0
    for chunk in pd.read_csv(
        path, dtype=str, keep_default_na=False, na_filter=False, chunksize=4096
    ):
        count += len(chunk)
        # 字符串解析、转换和 concat 的临时对象纳入保守工作集估计。
        if (
            count > limits["max_rows"]
            or config["data"]["bytes"] * 4 + count * len(expected) * 128
            > limits["max_memory_bytes"]
        ):
            raise ValueError("Stage row/memory limit exceeded")
        if any(
            len(value.encode()) > limits["max_field_bytes"]
            for column in chunk
            for value in chunk[column]
        ):
            raise ValueError("Stage field limit exceeded")
        for column in schema["columns"]:
            name = column["name"]
            values = chunk[name].map(decode_cell)
            if column["kind"] == "numeric":
                values = pd.to_numeric(values, errors="raise")
                if np.isinf(values.to_numpy(dtype=float, na_value=np.nan)).any():
                    raise ValueError("Infinite numeric feature")
            elif column["kind"] == "boolean":
                if any(v not in (None, "True", "False") for v in values):
                    raise ValueError("Invalid boolean feature")
                values = values.map({"True": True, "False": False}).astype("boolean")
            elif column["kind"] == "datetime":
                values = pd.to_datetime(values, errors="raise")
            elif column["kind"] == "categorical" and column["categories"] is not None:
                if any(v is not None and v not in column["categories"] for v in values):
                    raise ValueError("Unknown nominal feature")
                values = pd.Categorical(values, categories=column["categories"])
            else:
                values = values.map(lambda value: np.nan if value is None else value)
            chunk[name] = values
        parts.append(chunk)
    if not count:
        raise ValueError("Empty stage data")
    frame = pd.concat(parts, ignore_index=True)
    del parts
    ids = frame.pop(protocol["id_column"]).tolist()
    if len(set(ids)) != len(ids) or any(not identity.strip() for identity in ids):
        raise ValueError("Invalid stage identity")
    target = None
    if stage == "fit":
        encoded = {}
        for definition in protocol["targets"]:
            values = frame.pop(definition["name"])
            if protocol["kind"] == "regression":
                numbers = pd.to_numeric(values, errors="raise")
                if not np.isfinite(numbers).all():
                    raise ValueError("Invalid regression labels")
                encoded[definition["name"]] = numbers
            else:
                if set(values) != set(definition["classes"]):
                    raise ValueError("Training target class coverage mismatch")
                encoded[definition["name"]] = values.map(
                    {label: i for i, label in enumerate(definition["classes"])}
                ).astype(np.int64)
        target = (
            pd.DataFrame(encoded)
            if protocol["kind"] == "multilabel"
            else encoded[targets[0]].to_numpy()
        )
    return frame, target, ids, schema


def aligned_classes(model, protocol):
    raw = model.classes_
    if protocol["kind"] == "multilabel":
        if not isinstance(raw, (list, tuple)) or len(raw) != len(protocol["targets"]):
            raise ValueError("Model target classes shape mismatch")
    else:
        raw = [raw]
    result = []
    for target, values in zip(protocol["targets"], raw, strict=True):
        classes = class_indices(values, len(target["classes"]))
        if sorted(classes.tolist()) != list(range(len(target["classes"]))):
            raise ValueError(f"Model class set mismatch: {target['name']}")
        result.append(classes)
    return result


def predict_values(model, frame, ids, protocol):
    values = {protocol["id_column"]: ids}
    if protocol["kind"] == "regression":
        prediction = np.asarray(model.predict(frame), dtype=float)
        if prediction.shape != (len(ids),) or not np.isfinite(prediction).all():
            raise ValueError("Expected finite scalar prediction per row")
        values[protocol["prediction"]["targets"][0]["value_column"]] = prediction
    elif protocol["output"] == "label":
        target = protocol["targets"][0]
        encoded = class_indices(model.predict(frame), len(target["classes"]))
        if len(encoded) != len(ids):
            raise ValueError("Prediction row mismatch")
        values[protocol["prediction"]["targets"][0]["value_column"]] = [
            target["classes"][i] for i in encoded
        ]
    else:
        classes = aligned_classes(model, protocol)
        raw = model.predict_proba(frame)
        if protocol["kind"] == "multilabel":
            if not isinstance(raw, (list, tuple)) or len(raw) != len(
                protocol["targets"]
            ):
                raise ValueError("Probability target shape mismatch")
        else:
            raw = [raw]
        for target, spec, order, matrix in zip(
            protocol["targets"],
            protocol["prediction"]["targets"],
            classes,
            raw,
            strict=True,
        ):
            aligned = probabilities(matrix, len(ids), len(order))[:, np.argsort(order)]
            if spec["ranked_column"]:
                ranking = np.argsort(-aligned, axis=1, kind="stable")[
                    :, : min(3, len(order))
                ]
                values[spec["ranked_column"]] = [
                    json.dumps(
                        [target["classes"][index] for index in row],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    for row in ranking
                ]
            else:
                values[spec["value_column"]] = [
                    target["classes"][index] for index in np.argmax(aligned, axis=1)
                ]
            for i, name in enumerate(spec["probability_columns"]):
                values[name] = aligned[:, i]
    return values


def run_v4(stage, base, destination, config):
    from .runner import ModelArtifactLimitError, load_candidate

    fields(
        config,
        [
            "schema_version",
            "protocol",
            "seed",
            "model_artifact",
            "limits",
            "data",
            "feature_schema",
        ],
    )
    if config["schema_version"] != 4 or stage not in ("fit", "predict"):
        raise ValueError("Invalid stage version/action")
    protocol = validate_protocol_v2(config["protocol"])
    config["limits"] = validate_limits(config["limits"])
    if type(config["seed"]) is not int or not 0 <= config["seed"] < 2**32:
        raise ValueError("Invalid model seed")
    artifact = config["model_artifact"]
    fields(artifact, ["compression", "max_bytes"])
    if (
        artifact["compression"] != "zlib-3"
        or type(artifact["max_bytes"]) is not int
        or artifact["max_bytes"] < 1
    ):
        raise ValueError("Invalid model artifact policy")
    frame, target, ids, schema = load_stage_data(base, config, stage)
    candidate = load_candidate(base / "candidate.py")
    if stage == "fit":
        model = candidate.build_pipeline(config["seed"])
        model.fit(frame, target)
        if protocol["output"] in (
            "probabilities",
            "multilabel-probabilities",
            "ranked-labels",
        ):
            aligned_classes(model, protocol)
        path = destination / "model.joblib"
        joblib.dump(
            {
                "schema_version": 2,
                "protocol": protocol,
                "feature_schema": schema,
                "estimator": model,
            },
            path,
            compress=("zlib", 3),
        )
        if path.stat().st_size > artifact["max_bytes"]:
            size = path.stat().st_size
            path.unlink()
            raise ModelArtifactLimitError(
                f"compressed model.joblib bytes={size} exceeds "
                f"max_bytes={artifact['max_bytes']}"
            )
        (destination / "model-metadata.json").write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "protocol": protocol,
                    "feature_schema_sha256": config["feature_schema"]["sha256"],
                },
                ensure_ascii=False,
            )
        )
    else:
        saved = joblib.load(base / "model.joblib")
        if (
            not isinstance(saved, dict)
            or set(saved)
            != {"schema_version", "protocol", "feature_schema", "estimator"}
            or saved["schema_version"] != 2
            or saved["protocol"] != protocol
            or saved["feature_schema"] != schema
        ):
            raise ValueError("Saved model protocol/schema mismatch")
        values = predict_values(saved["estimator"], frame, ids, protocol)
        output = destination / "predictions.csv"
        with output.open("x", newline="") as stream:
            writer = csv.writer(stream)
            columns = prediction_columns_v2(protocol)
            writer.writerow(columns)
            for index in range(len(ids)):
                row = [values[column][index] for column in columns]
                if any(
                    len(str(v).encode()) > config["limits"]["max_field_bytes"]
                    for v in row
                ):
                    raise ValueError("Prediction field limit exceeded")
                writer.writerow(row)
                if stream.tell() > config["limits"]["max_file_bytes"]:
                    raise ValueError("Prediction file limit exceeded")
    print(json.dumps({"stage": stage, "rows": len(ids)}))
