import hashlib
import json

import numpy as np
import pytest
from statigent_modeling.protocol import probabilities, validate_protocol
from statigent_modeling.runner import run


def protocol(kind="binary", metric="roc_auc", classes=None, positive="01"):
    classes = classes or ["01", "1"]
    output = "label" if metric == "accuracy" else "probabilities"
    value = {
        "version": 1,
        "kind": kind,
        "metric": metric,
        "direction": "minimize" if metric == "log_loss" else "maximize",
        "output": output,
        "classes": classes,
        "positive_class": positive,
        "prediction": {
            "column": "prediction",
            "probability_columns": [f"probability_{i}" for i in range(len(classes))]
            if output == "probabilities"
            else [],
        },
        "scoring_version": "tabular-metrics-v1",
    }
    value["protocol_sha256"] = hashlib.sha256(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return validate_protocol(value, "id")


def setup(tmp_path, p, code, version=2, max_bytes=1024 * 1024):
    config = {
        "schema_version": version,
        "protocol": p,
        "target": "target",
        "id_column": "id",
        "seed": 42,
    }
    if version == 3:
        config["model_artifact"] = {"compression": "zlib-3", "max_bytes": max_bytes}
    (tmp_path / "stage.json").write_text(json.dumps(config))
    (tmp_path / "candidate.py").write_text(code)
    (tmp_path / "data.csv").write_text(
        "id,x,target\n" + "".join(f"{i},{i},{c}\n" for i, c in enumerate(p["classes"]))
    )
    run("fit", str(tmp_path), str(tmp_path))
    assert json.loads((tmp_path / "model-metadata.json").read_text())["protocol"] == p
    (tmp_path / "data.csv").write_text("id,x\nNA,0\n01,1\n")
    run("predict", str(tmp_path), str(tmp_path))
    return (tmp_path / "predictions.csv").read_text()


CODE = """import numpy as np
class Model:
    def fit(self,X,y):
        assert list(X.columns)==['x']
        assert y.tolist()==list(range(len(y)))
        self.classes_=np.arange(len(y))[::-1]
        return self
    def predict_proba(self,X):
        p=np.arange(1,len(self.classes_)+1)
        return np.tile(p/p.sum(),(len(X),1))
    def predict(self,X):
        return np.zeros(len(X),dtype=int)
def build_pipeline(seed): return Model()
"""


@pytest.mark.parametrize(
    "kind,metric,classes,positive",
    [
        ("binary", "accuracy", ["01", "1"], "01"),
        ("binary", "roc_auc", ["01", "1"], "01"),
        ("multiclass", "log_loss", ["NA", "blue", "红色"], None),
    ],
)
def test_runner_round_trip(tmp_path, kind, metric, classes, positive):
    p = protocol(kind, metric, classes, positive)
    result = setup(tmp_path, p, CODE)
    assert "NA," in result and "01," in result
    assert f"NA,{classes[0]}" in result
    if metric != "accuracy":
        assert "probability_0" in result
        assert float(result.splitlines()[1].split(",")[2]) > 0.5 or len(classes) == 3


@pytest.mark.parametrize(
    "change",
    [
        "self.classes_=np.array([0,0])",
        "self.classes_=np.array([0])",
        "self.classes_=np.array([0,2])",
    ],
)
def test_bad_model_classes(tmp_path, change):
    with pytest.raises(ValueError):
        setup(
            tmp_path,
            protocol(),
            CODE.replace("self.classes_=np.arange(len(y))[::-1]", change),
        )


def test_bad_probability_and_interface(tmp_path):
    with pytest.raises(AttributeError):
        setup(
            tmp_path, protocol(), CODE.replace("def predict_proba", "def unavailable")
        )
    for value in (
        [[0.3, 0.3]],
        [[-0.1, 1.1]],
        [[float("nan"), 0]],
        [[0.5]],
        [[float("inf"), 0]],
    ):
        with pytest.raises(ValueError):
            probabilities(value, 1, 2)
    np.testing.assert_array_equal(probabilities([[0.5, 0.5]], 1, 2).argmax(axis=1), [0])


def test_legacy_stage(tmp_path):
    (tmp_path / "stage.json").write_text(
        json.dumps({"target": "target", "id_column": "id", "seed": 42})
    )
    (tmp_path / "candidate.py").write_text(
        "from sklearn.dummy import DummyRegressor\n"
        "def build_pipeline(seed): return DummyRegressor()\n"
    )
    (tmp_path / "data.csv").write_text("id,x,target\na,0,1\nb,1,3\n")
    run("fit", str(tmp_path), str(tmp_path))
    (tmp_path / "data.csv").write_text("id,x\nc,2\n")
    run("predict", str(tmp_path), str(tmp_path))
    assert (tmp_path / "predictions.csv").read_text() == "id,prediction\nc,2.0\n"


def test_accuracy_does_not_require_probability_interface_or_model_classes(tmp_path):
    code = CODE.replace("self.classes_=np.arange(len(y))[::-1]", "pass").replace(
        "def predict_proba", "def unavailable"
    )
    assert "NA,01" in setup(tmp_path, protocol(metric="accuracy"), code)


def test_compressed_model_roundtrip_and_size_failure(tmp_path):
    from statigent_modeling.runner import ModelArtifactLimitError

    code = CODE.replace("return self", "self.payload = np.zeros(200000); return self")
    expected = setup(tmp_path, protocol(), code)
    original_size = (tmp_path / "model.joblib").stat().st_size
    assert setup(tmp_path, protocol(), code, version=3) == expected
    assert (tmp_path / "model.joblib").stat().st_size < original_size / 10
    (tmp_path / "model-metadata.json").unlink()
    with pytest.raises(ModelArtifactLimitError, match="max_bytes=32"):
        setup(tmp_path, protocol(), code, version=3, max_bytes=32)
    assert not (tmp_path / "model.joblib").exists()
    assert not (tmp_path / "model-metadata.json").exists()


@pytest.mark.parametrize("limit", [0, -1, 1.5, True, "32"])
def test_invalid_artifact_policy(tmp_path, limit):
    with pytest.raises(ValueError, match="artifact policy"):
        setup(tmp_path, protocol(), CODE, version=3, max_bytes=limit)
