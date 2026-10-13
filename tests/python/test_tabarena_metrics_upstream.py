"""主运行时计算与独立锁定官方环境计算在同一预测上做差分。"""

import json
import os
import subprocess
from pathlib import Path

import pytest
from statigent_modeling.metrics_v2 import classification_metric, regression_metric

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
