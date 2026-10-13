"""A pipeline factory supplies the estimator; stage inputs determine what it can see."""

import importlib.util
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd


def load_candidate(path: Path):
    spec = importlib.util.spec_from_file_location("candidate", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load pipeline module")
    module = importlib.util.module_from_spec(spec)
    sys.modules["candidate"] = module
    spec.loader.exec_module(module)
    return module


def run(stage: str, root: str = "/input", output: str = "."):
    base, destination = Path(root), Path(output)
    config = json.loads((base / "stage.json").read_text())
    module = load_candidate(base / "candidate.py")
    frame = pd.read_csv(base / "data.csv", dtype={config["id_column"]: str})
    ids = frame.pop(config["id_column"])
    if stage == "fit":
        target = frame.pop(config["target"])
        model = module.build_pipeline(config["seed"])
        model.fit(frame, target)
        joblib.dump(model, destination / "model.joblib")
    elif stage == "predict":
        model = joblib.load(base / "model.joblib")
        predictions = np.asarray(model.predict(frame), dtype=float)
        if predictions.ndim != 1 or len(predictions) != len(ids):
            raise ValueError("Expected one scalar prediction per row")
        if not np.isfinite(predictions).all():
            raise ValueError("Non-finite predictions")
        pd.DataFrame({config["id_column"]: ids, "prediction": predictions}).to_csv(
            destination / "predictions.csv", index=False
        )
    else:
        raise ValueError("Unknown modeling stage")
    print(json.dumps({"stage": stage, "rows": len(ids)}))


if __name__ == "__main__":
    run(sys.argv[1])
