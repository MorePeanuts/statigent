"""显式可选 AutoGluon 环境测试；默认快速检查不会导入它。"""

import numpy as np
import pytest
from statigent_baselines.autogluon_metrics import score_encoded, scorer
from statigent_modeling.metrics_v2 import MetricUndefined
from statigent_modeling.protocol_v2 import DEFINITIONS

pytestmark = pytest.mark.upstream


@pytest.mark.parametrize("definition", DEFINITIONS, ids=lambda d: d["id"])
def test_actual_autogluon_scorer_matches_public_formula(definition):
    identity = definition["id"]
    kind = definition["kinds"][0]
    if kind == "regression":
        target = {"classes": [], "positive_class": None, "levels": None}
        actual, predicted = (
            np.array([1.0, 2.0, 3.0, 4.0]),
            np.array([1.2, 2.1, 2.8, 3.7]),
        )
    else:
        multi = kind in ("ordinal", "multiclass")
        target = {
            "classes": ["z", "a", "m", "b"] if multi else ["no", "yes"],
            "positive_class": None if multi else "yes",
            "levels": [0, 2, 5, 9] if kind == "ordinal" else None,
        }
        actual = np.array([0, 1, 0, 1])
        if identity in ("accuracy-v1", "micro-f1-v1", "quadratic-kappa-ds10-v1"):
            predicted = np.array([0, 1, 1, 1])
        else:
            predicted = (
                np.array([[0.25] * 4] * 4) if multi else np.array([0.2, 0.6, 0.5, 0.5])
            )
    metric = scorer(identity, target, kind)
    expected = score_encoded(actual, predicted, identity=identity, target=target)
    assert metric.convert_score_to_original(metric(actual, predicted)) == pytest.approx(
        expected, abs=1e-12
    )
    assert metric.greater_is_better_internal == (definition["direction"] == "maximize")


def test_actual_scorer_rejects_undefined_and_unknown():
    target = {"classes": [], "positive_class": None, "levels": None}
    with pytest.raises(MetricUndefined):
        scorer("r2-sklearn-v1", target, "regression")(np.array([1]), np.array([1]))
    with pytest.raises(ValueError):
        scorer("unknown", target, "regression")
