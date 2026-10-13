import csv
import hashlib
import json
import threading
import time

import numpy as np
import pandas as pd
import pytest
from statigent_modeling.data_v3 import file_descriptor
from statigent_modeling.scoring_v2 import score_v2

pytestmark = pytest.mark.upstream


def system(root, kind, **options):
    pytest.importorskip(
        "tabarena", reason="Install the pinned optional TabArena environment"
    )
    from autogluon.core.metrics import get_metric
    from statigent_benchmarks.tabarena_system import StatigentSystem

    return StatigentSystem(
        task_template={
            "method": "no_eda",
            "confirmation": {"mode": "none"},
            "resource_version": "tabarena-system-verification-v1",
            "goal": "Fit a reproducible prediction pipeline using training data only.",
            "image": "statigent-runtime:modeling-benchmarks",
            "budget": {
                "task_timeout_ms": 300000,
                "fit_timeout_ms": 60000,
                "predict_timeout_ms": 30000,
                "final_reserve_ms": 100000,
            },
        },
        mode="deterministic",
        run_root=root,
        prediction_timeout_seconds=30,
        problem_type=kind,
        eval_metric=get_metric(
            {"binary": "roc_auc", "multiclass": "log_loss", "regression": "rmse"}[kind],
            kind,
        ),
        validation_metadata={"target_name": "outcome"},
        fit_kwargs={
            "num_cpus": 1,
            "num_gpus": 0,
            "memory_limit": 2,
            "time_limit": 300,
            **options,
        },
    )


@pytest.mark.parametrize("kind", ["regression", "binary", "multiclass"])
def test_official_system_real_fit_and_deferred_predictions(tmp_path, kind, monkeypatch):
    from statigent_benchmarks.tabarena_compat import verify

    pytest.importorskip("tabarena")
    from autogluon.core.data.label_cleaner import LabelCleaner
    from tabarena.benchmark.experiment.experiment_runner import evaluate

    verify()
    monkeypatch.setenv("STATIGENT_PRIVATE_SENTINEL", "must-not-cross-bridge")
    model = system(tmp_path, kind)
    X = pd.DataFrame(
        {"number": np.arange(60) % 3, "nominal": ["01", "NA", "类别"] * 20}
    )
    y = pd.Series(
        [0.0, 1.0, 2.0] * 20
        if kind == "regression"
        else ["z", "01", "a"] * 20
        if kind == "multiclass"
        else ["01", "1"] * 30,
        name="outcome",
    )
    source_hash = hashlib.sha256(X.to_csv().encode() + y.to_csv().encode()).hexdigest()
    model._split_seed = 17
    model.fit(X, y)
    assert (
        hashlib.sha256(X.to_csv().encode() + y.to_csv().encode()).hexdigest()
        == source_hash
    )
    assert "STATIGENT_PRIVATE_SENTINEL" not in model.bridge.environment
    prepared = json.loads((model.directory / "prepared/dataset.json").read_text())
    assert prepared["prediction"] is None and prepared["evaluator"]["labels"] is None
    assert prepared["seed"] == 17
    frozen = model.frozen_root / "frozen/model.json"
    before = hashlib.sha256(frozen.read_bytes()).hexdigest()
    recorded = json.loads((model.directory / "system.json").read_text())
    assert recorded["task"]["limits"]["cpus"] == 1
    assert recorded["task"]["limits"]["memory_bytes"] == 2 * 10**9
    assert 0 < recorded["task"]["budget"]["task_timeout_ms"] <= 300000
    assert model.fit_response["live_llm_calls"] == 0
    assert model.fit_response["controlled_decisions"] == 2
    test_x, test_y = X.iloc[[3, 1, 2, 0]], y.iloc[[3, 1, 2, 0]]
    predictions = []
    for _ in range(2):
        predictions.append(
            model.predict(test_x)
            if kind == "regression"
            else model.predict_proba(test_x)
        )
    assert predictions[0].equals(predictions[1]) and predictions[0].index.equals(
        test_x.index
    )
    if kind != "regression":
        assert list(predictions[0].columns) == model.raw_classes
        assert np.allclose(predictions[0].sum(axis=1), 1)
    assert len({r["run_id"] for r in model.prediction_records}) == 2
    assert all(
        r["calls"] == {"models": 0, "fits": 0, "predictions": 1}
        for r in model.prediction_records
    )
    assert hashlib.sha256(frozen.read_bytes()).hexdigest() == before
    labels = model.directory / "labels.csv"
    with labels.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow([model.id_column, model.target])
        writer.writerows((f"predict:{i}", value) for i, value in enumerate(test_y))
    ref = file_descriptor(model.directory, "labels.csv", model.data_limits)
    ref["path"] = str(labels)
    score = score_v2(
        {
            "version": 2,
            "request_id": "official-system",
            "protocol": model.protocol,
            "evaluation_id": "a" * 64,
            "partition": "test",
            "labels": ref,
            "predictions": model.prediction_records[-1]["predictions"],
            "limits": model.data_limits,
        }
    )
    error = evaluate(
        test_y,
        predictions[0] if kind == "regression" else predictions[0].idxmax(axis=1),
        None if kind == "regression" else predictions[0],
        model.eval_metric,
        kind,
        None
        if kind == "regression"
        else LabelCleaner.construct(problem_type=kind, y=y),
    )
    assert (
        abs((1 - score["value"] if kind == "binary" else score["value"]) - error)
        < 1e-12
    )
    if kind == "binary":
        failures = []

        def predict():
            try:
                model.predict_proba(test_x)
            except RuntimeError as error:
                failures.append(str(error))

        thread = threading.Thread(target=predict)
        thread.start()
        deadline = time.monotonic() + 10
        while (
            model.bridge.active is None
            and thread.is_alive()
            and time.monotonic() < deadline
        ):
            time.sleep(0.05)
        time.sleep(2)
        model.cleanup()
        thread.join(timeout=35)
        assert not thread.is_alive() and failures
        assert model.bridge.active is None
        cancellations = [
            json.loads(path.read_text())
            for path in (model.directory / "bridge").glob("*/bridge.json")
        ]
        assert any(
            r["failure"] == "cancelled" and not r["forced_termination"]
            for r in cancellations
        )
    sibling = tmp_path / "unrelated.txt"
    sibling.write_text("keep")
    model.cleanup()
    assert sibling.read_text() == "keep" and frozen.is_file()
    with pytest.raises(RuntimeError, match="not available"):
        model.predict(test_x)


@pytest.mark.parametrize(
    "constraint",
    [{"num_gpus": 1}, {"num_cpus": 0}, {"memory_limit": 0.01}, {"time_limit": 1}],
)
def test_official_system_constraints_fail_before_decisions(tmp_path, constraint):
    model = system(tmp_path, "binary", **constraint)
    X = pd.DataFrame({"x": range(20)})
    y = pd.Series(["01", "1"] * 10)
    with pytest.raises((ValueError, RuntimeError, TimeoutError)):
        model.fit(X, y)
    assert not list(model.directory.glob("native/*/modeling.json"))
    model.cleanup()
