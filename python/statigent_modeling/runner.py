"""A pipeline factory supplies the estimator; stage inputs determine what it can see."""

import csv
import importlib.util
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from statigent_modeling.protocol import class_indices, probabilities, validate_protocol


class ModelArtifactLimitError(ValueError):
    """A fully serialized model exceeds its declared delivery limit."""


def load_candidate(path: Path):
    spec = importlib.util.spec_from_file_location("candidate", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load pipeline module")
    module = importlib.util.module_from_spec(spec)
    sys.modules["candidate"] = module
    spec.loader.exec_module(module)
    return module


def model_classes(model, p):
    classes = class_indices(model.classes_, len(p["classes"]))
    if sorted(classes.tolist()) != list(range(len(p["classes"]))):
        raise ValueError("Model class set mismatch")
    return classes


def run(stage: str, root: str = "/input", output: str = "."):
    base, destination = Path(root), Path(output)
    config = json.loads((base / "stage.json").read_text())
    version = config.get("schema_version", 1)
    if version not in (1, 2, 3):
        raise ValueError("Unsupported stage version")
    p = (
        validate_protocol(config["protocol"], config["id_column"])
        if version >= 2
        else None
    )
    if version == 1 and set(config) != {"target", "id_column", "seed"}:
        raise ValueError("Invalid legacy stage fields")
    fields = {
        "schema_version",
        "protocol",
        "target",
        "id_column",
        "seed",
    }
    if version == 3:
        fields.add("model_artifact")
        artifact = config["model_artifact"]
        if (
            not isinstance(artifact, dict)
            or set(artifact) != {"compression", "max_bytes"}
            or artifact["compression"] != "zlib-3"
            or type(artifact["max_bytes"]) is not int
            or artifact["max_bytes"] < 1
        ):
            raise ValueError("Invalid model artifact policy")
    if version >= 2 and set(config) != fields:
        raise ValueError("Invalid stage fields")
    load_candidate(base / "candidate.py")
    # Features use pandas inference; IDs and labels retain CSV spelling.
    with (base / "data.csv").open(newline="") as f:
        literal = list(csv.DictReader(f))
    frame = pd.read_csv(base / "data.csv", dtype={config["id_column"]: str})
    frame.pop(config["id_column"])
    ids = [r[config["id_column"]] for r in literal]
    if len(frame) != len(ids):
        raise ValueError("CSV row mismatch")
    if stage == "fit":
        target = frame.pop(config["target"])
        if p and p["kind"] != "regression":
            mapping = {c: i for i, c in enumerate(p["classes"])}
            target = np.asarray(
                [mapping[r[config["target"]]] for r in literal], dtype=np.int64
            )
        model = sys.modules["candidate"].build_pipeline(config["seed"])
        model.fit(frame, target)
        if p and p["output"] == "probabilities":
            model_classes(model, p)
        model_path = destination / "model.joblib"
        joblib.dump(
            {"protocol": p, "estimator": model} if p else model,
            model_path,
            compress=("zlib", 3) if version == 3 else 0,
        )
        if version == 3:
            size = model_path.stat().st_size
            if size > config["model_artifact"]["max_bytes"]:
                # Remove before notebook artifact collection, so a known size
                # error cannot turn into an incomplete transport/persistence.
                model_path.unlink()
                raise ModelArtifactLimitError(
                    f"compressed model.joblib bytes={size} exceeds "
                    f"max_bytes={config['model_artifact']['max_bytes']}; "
                    "reduce model size and retry within the search repair allowance"
                )
        if p:
            (destination / "model-metadata.json").write_text(
                json.dumps({"schema_version": 1, "protocol": p}, ensure_ascii=False)
            )
    elif stage == "predict":
        saved = joblib.load(base / "model.joblib")
        if p:
            if (
                not isinstance(saved, dict)
                or saved.get("protocol") != p
                or "estimator" not in saved
            ):
                raise ValueError("Saved model protocol mismatch")
            model = saved["estimator"]
        else:
            model = saved
        column = p["prediction"]["column"] if p else "prediction"
        values = {config["id_column"]: ids}
        if not p or p["kind"] == "regression":
            predictions = np.asarray(model.predict(frame), dtype=float)
            if (
                predictions.ndim != 1
                or len(predictions) != len(ids)
                or not np.isfinite(predictions).all()
            ):
                raise ValueError("Expected finite scalar prediction per row")
            values[column] = predictions
        else:
            if p["output"] == "probabilities":
                classes = model_classes(model, p)
                raw = probabilities(model.predict_proba(frame), len(ids), len(classes))
                aligned = raw[:, np.argsort(classes)]
                encoded = np.argmax(aligned, axis=1)
                values[column] = [p["classes"][i] for i in encoded]
                for i, name in enumerate(p["prediction"]["probability_columns"]):
                    values[name] = aligned[:, i]
            else:
                encoded = class_indices(model.predict(frame), len(p["classes"]))
                if len(encoded) != len(ids):
                    raise ValueError("Prediction row mismatch")
                values[column] = [p["classes"][i] for i in encoded]
        pd.DataFrame(values).to_csv(destination / "predictions.csv", index=False)
    else:
        raise ValueError("Unknown modeling stage")
    print(json.dumps({"stage": stage, "rows": len(ids)}))


if __name__ == "__main__":
    run(sys.argv[1])
