"""主运行时计算与独立锁定官方环境计算在同一预测上做差分。"""

import csv
import json
import os
import subprocess
from pathlib import Path

import pytest
from statigent_benchmarks.delivery import export_delivery
from statigent_modeling.data_v3 import file_descriptor, prepare_rows
from statigent_modeling.metrics_v2 import classification_metric, regression_metric
from statigent_modeling.protocol_v2 import prediction_columns_v2
from statigent_modeling.scoring_v2 import score_v2
from test_modeling_dataset_v3 import LIMITS

pytestmark = pytest.mark.upstream
ROOT = Path(__file__).resolve().parents[2]
OFFICIAL = """
import json, sys
import pandas as pd
from autogluon.core.data.label_cleaner import LabelCleaner
from autogluon.core.metrics import get_metric
from tabarena.benchmark.experiment.experiment_runner import evaluate
from statigent_benchmarks.tabarena_compat import verify
evidence = verify()
results = []
for case in json.load(sys.stdin):
    y = pd.Series(case['labels'])
    kind, name = case['kind'], case['metric']
    cleaner = LabelCleaner.construct(problem_type=kind, y=y)
    if kind == 'regression':
        prediction, probabilities = pd.Series(case['predictions']), None
    else:
        probabilities = pd.DataFrame(
            case['probabilities'], columns=case['classes'], dtype=float
        )
        probabilities = probabilities[cleaner.ordered_class_labels]
        prediction = probabilities.idxmax(axis=1)
    error = evaluate(
        y, prediction, probabilities, get_metric(name, kind), kind, cleaner
    )
    results.append(float(error))
print(json.dumps(
    {'errors': results, 'environment': evidence['dependencies']}, allow_nan=False
))
"""


def test_official_tabarena_metrics_match_main_environment(tmp_path):
    cases = [
        {
            "kind": "regression",
            "metric": "rmse",
            "labels": [1, 2, 5, 9],
            "predictions": [1.5, 1.2, 6, 7],
        },
        {
            "kind": "binary",
            "metric": "roc_auc",
            "labels": ["no", "yes", "no", "yes"],
            "classes": ["no", "yes"],
            "probabilities": [[0.2, 0.8], [0.2, 0.8], [0.6, 0.4], [0.9, 0.1]],
        },
        {
            "kind": "multiclass",
            "metric": "log_loss",
            "labels": ["01", "1", "NA", "红"],
            "classes": ["01", "1", "NA", "红"],
            "probabilities": [
                [0.1, 0.2, 0.3, 0.4],
                [0.2, 0.5, 0.1, 0.2],
                [0.25, 0.25, 0.25, 0.25],
                [1.0, 0, 0, 0],
            ],
        },
    ]
    expected = []
    for case in cases:
        if case["kind"] == "regression":
            expected.append(
                regression_metric("rmse-v1", case["labels"], case["predictions"])
            )
        else:
            target = {
                "name": "target",
                "classes": case["classes"],
                "positive_class": "yes" if case["kind"] == "binary" else None,
                "levels": None,
            }
            value = classification_metric(
                "roc-auc-v1" if case["kind"] == "binary" else "log-loss-sklearn-v1",
                target,
                case["labels"],
                proba=case["probabilities"],
            )
            expected.append(1 - value if case["kind"] == "binary" else value)
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "UV_CACHE_DIR")
        if key in os.environ
    }
    environment.update(
        {
            "PYTHONPATH": str(ROOT / "python"),
            "OPENML_CACHE_DIR": str(tmp_path / "openml"),
        }
    )
    result = subprocess.run(
        [
            "uv",
            "run",
            "--offline",
            "--no-sync",
            "--frozen",
            "--project",
            str(ROOT / "environments/tabarena"),
            "python",
            "-c",
            OFFICIAL,
        ],
        cwd=ROOT,
        env=environment,
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["errors"] == pytest.approx(expected, abs=1e-12, rel=1e-12)
    assert output["environment"]["scikit-learn"] == "1.9.1"


@pytest.mark.parametrize("kind", ["regression", "binary", "multiclass"])
def test_frozen_tabarena_predictions_export_and_official_score(tmp_path, kind):
    classes = (
        None
        if kind == "regression"
        else ["01", "1"]
        if kind == "binary"
        else ["01", "1", "红"]
    )
    values = [
        i / 3 if classes is None else classes[i % len(classes)] for i in range(60)
    ]
    root = tmp_path / "prepared"
    metric = {
        "regression": "rmse-v1",
        "binary": "roc-auc-v1",
        "multiclass": "log-loss-sklearn-v1",
    }[kind]
    dataset = prepare_rows(
        root,
        kind=kind,
        metric_id=metric,
        id_column="sample_id",
        targets=[
            dict(
                name="y",
                classes=classes,
                positive_class="1" if kind == "binary" else None,
                levels=None,
            )
        ],
        features=[
            dict(name="x", kind="numeric", source_type="synthetic", categories=None)
        ],
        excluded_columns=[],
        train=[(f"train:{i}", i, dict(x=i, y=values[i])) for i in range(48)],
        prediction=[(f"test:{i}", i, dict(x=i)) for i in range(48, 60)],
        labels=[(f"test:{i}", [values[i]]) for i in range(48, 60)],
        seed=17,
        limits=LIMITS,
        provenance=dict(
            benchmark="tabarena-lite",
            task_id="fixture",
            source_revision="a" * 40,
            outer_split="openml-r0f0",
            openml=dict(dataset_id="123", version=1, repeat=0, fold=0),
            original_classes=[dict(canonical=c, value=c) for c in classes or []],
        ),
    )
    p = dataset["protocol"]
    with (tmp_path / "predictions.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(prediction_columns_v2(p))
        for i in reversed(range(48, 60)):
            if classes is None:
                writer.writerow([f"test:{i}", values[i] + 0.5])
            else:
                probabilities = [
                    0.8 if c == values[i] else 0.2 / (len(classes) - 1) for c in classes
                ]
                writer.writerow([f"test:{i}", values[i], *probabilities])
    prediction = file_descriptor(tmp_path, "predictions.csv", LIMITS)
    prediction["path"] = str(tmp_path / prediction["path"])
    labels = {
        **dataset["evaluator"]["labels"],
        "path": str(root / dataset["evaluator"]["labels"]["path"]),
    }
    local = score_v2(
        dict(
            version=2,
            request_id="main",
            protocol=p,
            evaluation_id="e" * 64,
            partition="test",
            labels=labels,
            predictions=prediction,
            limits=LIMITS,
        )
    )
    export_delivery(
        dict(
            version=1,
            request_id="export",
            prepared_root=str(root),
            dataset_sha256=dataset["dataset_sha256"],
            predictions=prediction,
            destination=str(tmp_path / "export.csv"),
        )
    )
    with (tmp_path / "export.csv").open() as stream:
        rows = list(csv.reader(stream))
    assert [int(r[0]) for r in rows[1:]] == list(range(48, 60))
    assert rows[0] == [
        "source_row",
        *(["y"] if classes is None else ["1"] if kind == "binary" else classes),
    ]
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "UV_CACHE_DIR")
        if key in os.environ
    }
    environment["PYTHONPATH"] = str(ROOT / "python")
    request = dict(
        version=1,
        request_id="official",
        prepared_root=str(root),
        dataset_sha256=dataset["dataset_sha256"],
        predictions=prediction,
        native_score=local["value"],
    )
    result = subprocess.run(
        [
            "uv",
            "run",
            "--offline",
            "--no-sync",
            "--frozen",
            "--project",
            str(ROOT / "environments/tabarena"),
            "python",
            "-m",
            "statigent_benchmarks.official_predictions",
        ],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        env=environment,
        cwd=ROOT,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    response = json.loads(result.stdout)
    assert response["ok"], response
    assert response["result"]["calls"] == {"models": 0, "fits": 0}
    assert response["result"]["predictions"] == prediction
    assert response["result"]["canonical_classes"] == (classes or [])
