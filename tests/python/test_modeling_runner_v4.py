import csv
import json
import shutil

import pytest
from statigent_modeling.data_v3 import prepare_rows
from statigent_modeling.limits import DEFAULT_DATA_LIMITS
from statigent_modeling.runner import run


def fixture(tmp_path, kind, target_count=1, include_labels=False):
    names = [f"y{i}" for i in range(target_count)]
    classes = (
        ["3", "5", "8"]
        if kind == "ordinal"
        else ["01", "1", "类别", "紅"]
        if kind == "multiclass"
        else ["01", "1"]
    )
    metric = {
        "regression": "mae-v1",
        "binary": "roc-auc-v1",
        "multiclass": "top3-hit-ds-v1",
        "ordinal": "quadratic-kappa-ds10-v1",
        "multilabel": "mean-target-auc-v1",
    }[kind]
    targets = [
        {
            "name": name,
            "classes": [] if kind == "regression" else classes,
            "positive_class": "1" if kind in ("binary", "multilabel") else None,
            "levels": [3, 5, 8] if kind == "ordinal" else None,
        }
        for name in names
    ]
    prepared = tmp_path / "prepared"
    manifest = prepare_rows(
        prepared,
        kind=kind,
        metric_id=metric,
        id_column="id",
        targets=targets,
        features=[
            {
                "name": "x",
                "kind": "numeric",
                "source_type": "synthetic",
                "categories": None,
            }
        ],
        excluded_columns=[],
        train=(
            (
                f"train:{i}",
                i,
                {
                    "x": i,
                    **{
                        name: i if kind == "regression" else classes[i % len(classes)]
                        for name in names
                    },
                },
            )
            for i in range(40)
        ),
        prediction=((f"test:{i}", i, {"x": i}) for i in range(4)),
        labels=[
            (
                f"test:{i}",
                [
                    i if kind == "regression" else classes[i % len(classes)]
                    for _ in names
                ],
            )
            for i in range(4)
        ]
        if include_labels
        else None,
        seed=17,
        limits=DEFAULT_DATA_LIMITS,
        provenance={"benchmark": "synthetic"},
    )
    code = """import numpy as np
class Model:
    def fit(self,X,y):
        assert list(X.columns)==['x']
        assert X.x.dtype.kind in 'fi'
        self.multi = getattr(y, 'ndim') == 2
        if self.multi:
            assert list(y.columns)==TARGETS
            self.classes_=[np.unique(y[c])[::(-1 if i%2 else 1)]
                           for i,c in enumerate(y.columns)]
        else:
            self.classes_=np.unique(y)[::-1]
        return self
    def predict(self,X): return np.zeros(len(X),dtype=int)
    def predict_proba(self,X):
        if self.multi:
            return [np.tile([0.25,0.75] if i%2==0 else [0.75,0.25],(len(X),1))
                    for i in range(len(self.classes_))]
        return np.full((len(X),len(self.classes_)),1/len(self.classes_))
def build_pipeline(seed): return Model()
""".replace("TARGETS", repr(names))
    fit, predict = tmp_path / "fit", tmp_path / "predict"
    fit.mkdir()
    predict.mkdir()
    for directory, data in [
        (fit, manifest["training"]),
        (predict, manifest["prediction"]),
    ]:
        shutil.copyfile(prepared / data["path"], directory / "data.csv")
        shutil.copyfile(
            prepared / manifest["feature_schema"]["path"], directory / "features.json"
        )
        (directory / "candidate.py").write_text(code)
        config = {
            "schema_version": 4,
            "protocol": manifest["protocol"],
            "seed": 17,
            "model_artifact": {"compression": "zlib-3", "max_bytes": 1024 * 1024},
            "limits": DEFAULT_DATA_LIMITS,
            "data": {**data, "path": "data.csv"},
            "feature_schema": {**manifest["feature_schema"], "path": "features.json"},
        }
        (directory / "stage.json").write_text(json.dumps(config))
    return fit, predict, manifest


@pytest.mark.parametrize(
    "kind,count",
    [
        ("regression", 1),
        ("binary", 1),
        ("ordinal", 1),
        ("multiclass", 1),
        ("multilabel", 2),
        ("multilabel", 7),
    ],
)
def test_extended_model_roundtrip(tmp_path, kind, count):
    fit, predict, manifest = fixture(tmp_path, kind, count)
    run("fit", str(fit), str(fit))
    metadata = json.loads((fit / "model-metadata.json").read_text())
    assert metadata["schema_version"] == 2
    assert metadata["protocol"] == manifest["protocol"]
    shutil.copyfile(fit / "model.joblib", predict / "model.joblib")
    run("predict", str(predict), str(predict))
    with (predict / "predictions.csv").open() as stream:
        rows = list(csv.DictReader(stream))
    assert [r["id"] for r in rows] == [f"test:{i}" for i in range(4)]
    if kind == "ordinal":
        assert rows[0]["prediction_0"] == "3"
    elif kind == "multiclass":
        assert (
            json.loads(rows[0]["ranked_0"])
            == manifest["protocol"]["targets"][0]["classes"][:3]
        )
    elif kind == "multilabel":
        for i in range(count):
            assert rows[0][f"prediction_{i}"] == "1"
            assert rows[0][f"probability_{i}_1"] == "0.75"
        assert sum(float(rows[0][f"probability_{i}_1"]) for i in range(count)) > 1


def test_wrong_target_order_fails_before_candidate_execution(tmp_path):
    fit, _, _ = fixture(tmp_path, "multilabel", 2)
    path = fit / "data.csv"
    path.write_bytes(path.read_bytes().replace(b"y0,y1", b"y1,y0"))
    (fit / "candidate.py").write_text("raise RuntimeError('candidate must not run')")
    with pytest.raises(ValueError, match="hash mismatch"):
        run("fit", str(fit), str(fit))
    assert not (fit / "model.joblib").exists()


def test_multilabel_missing_target_classes_and_model_limit(tmp_path):
    fit, predict, _ = fixture(tmp_path, "multilabel", 2)
    code = (fit / "candidate.py").read_text()
    (fit / "candidate.py").write_text(
        code.replace("return self", "self.classes_=self.classes_[:1]; return self")
    )
    with pytest.raises(ValueError, match="target classes"):
        run("fit", str(fit), str(fit))
    (fit / "candidate.py").write_text(code)
    run("fit", str(fit), str(fit))
    shutil.copyfile(fit / "model.joblib", predict / "model.joblib")
    (predict / "candidate.py").write_text(
        code.replace("return [np.tile", "return [np.tile").replace(
            "range(len(self.classes_))", "range(1)"
        )
    )
    with pytest.raises(ValueError, match="Probability target shape"):
        run("predict", str(predict), str(predict))
