import numpy as np
import pytest
from statigent_baselines.autogluon_metrics import CUSTOM, NATIVE, score_encoded
from statigent_baselines.autogluon_model import encoded_target
from statigent_modeling.metrics_v2 import (
    MetricUndefined,
    classification_metric,
    regression_metric,
)
from statigent_modeling.protocol_v2 import DEFINITIONS


@pytest.mark.parametrize("definition", DEFINITIONS, ids=lambda d: d["id"])
def test_every_frozen_metric_has_exact_internal_selection(definition):
    identity = definition["id"]
    assert identity in NATIVE or identity in CUSTOM
    if "regression" in definition["kinds"]:
        target = {"classes": [], "positive_class": None, "levels": None}
        actual, predicted = [1.0, 2.0, 3.0, 4.0], [1.2, 2.1, 2.8, 3.7]
        expected = regression_metric(identity, actual, predicted)
    else:
        ordinal = "ordinal" in definition["kinds"]
        multiple = ordinal or identity == "top3-hit-ds-v1"
        target = {
            "classes": ["z", "a", "m", "b"] if multiple else ["yes", "no"],
            "positive_class": None if multiple else "yes",
            "levels": [0, 2, 5, 9] if ordinal else None,
        }
        target = encoded_target(target)
        actual = [0, 1, 0, 1]
        labels = [target["classes"][i] for i in actual]
        if identity in ("accuracy-v1", "micro-f1-v1", "quadratic-kappa-ds10-v1"):
            predicted = [0, 1, 1, 1]
            expected = classification_metric(
                identity,
                target,
                labels,
                predicted=[target["classes"][i] for i in predicted],
            )
        else:
            predicted = (
                np.array([[0.25] * 4] * 4)
                if multiple
                else np.array([[0.8, 0.2], [0.4, 0.6], [0.5, 0.5], [0.5, 0.5]])
            )
            ranked = [target["classes"][:3]] * 4 if multiple else None
            expected = classification_metric(
                "roc-auc-v1" if identity == "mean-target-auc-v1" else identity,
                target,
                labels,
                proba=predicted,
                ranked=ranked,
            )
    assert score_encoded(
        actual, predicted, identity=identity, target=target
    ) == pytest.approx(expected, abs=1e-14)


def test_undefined_domains_and_positive_encoding():
    target = encoded_target(
        {"classes": ["yes", "no"], "positive_class": "yes", "levels": None}
    )
    assert target["classes"] == ["no", "yes"]
    for identity in (
        "roc-auc-v1",
        "mean-target-auc-v1",
        "normalized-gini-ds-v1",
        "log-loss-sklearn-inferred-binary-v1",
    ):
        with pytest.raises(MetricUndefined):
            score_encoded([0, 0], [0.1, 0.2], identity=identity, target=target)
    with pytest.raises(MetricUndefined):
        score_encoded([0], [0], identity="smape-ds-v1", target={"classes": []})
    with pytest.raises(ValueError):
        score_encoded([0], [0], identity="unknown", target={"classes": []})
