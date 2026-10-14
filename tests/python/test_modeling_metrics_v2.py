import math

import numpy as np
import pytest
from sklearn.metrics import (
    mean_absolute_error,
    mean_squared_log_error,
    median_absolute_error,
    root_mean_squared_error,
)
from statigent_modeling.metrics_v2 import (
    InvalidPredictions,
    MetricUndefined,
    classification_metric,
    mean_target_auc,
    regression_metric,
)


@pytest.mark.parametrize(
    "identity,reference",
    [
        ("rmse-v1", root_mean_squared_error),
        ("mae-v1", mean_absolute_error),
        ("median-absolute-error-v1", median_absolute_error),
    ],
)
def test_original_scale_errors(identity, reference):
    actual, predicted = [1, 10, 200], [3, 5, 180]
    assert regression_metric(identity, actual, predicted) == pytest.approx(
        reference(actual, predicted)
    )


@pytest.mark.parametrize(
    "identity", ["rmsle-numpy-log-v1", "rmsle-numpy-log1p-v1", "rmsle-sklearn-v1"]
)
def test_rmsle_frozen_domains(identity):
    actual, predicted = [-0.5, 1, 5], [-0.25, 2, 7]
    before = list(predicted)
    assert regression_metric(identity, actual, predicted) == pytest.approx(
        math.sqrt(mean_squared_log_error(actual, predicted))
    )
    assert predicted == before
    with pytest.raises(InvalidPredictions, match="domain"):
        regression_metric(identity, actual, [-1, 2, 7])
    with pytest.raises(MetricUndefined, match="labels"):
        regression_metric(identity, [-1, 1, 5], predicted)


def test_smape_zero_policy_and_constant_r2():
    with pytest.raises(MetricUndefined, match="double zero"):
        regression_metric("smape-ds-v1", [0, 1], [0, 3])
    assert regression_metric("smape-zero-v1", [0, 1], [0, 3]) == 0.5
    assert regression_metric("smape-ds-v1", [1, 2], [-1, -2]) == 2
    assert regression_metric("r2-sklearn-v1", [3, 3], [3, 3]) == 1
    assert regression_metric("r2-sklearn-v1", [3, 3], [2, 4]) == 0
    assert regression_metric("r2-sklearn-v1", [1, 2], [10, 20]) < 0
    with pytest.raises(MetricUndefined):
        regression_metric("r2-sklearn-v1", [1], [1])


def test_numeric_validation_and_overflow_are_not_success():
    for predictions in [[np.nan, 1], [np.inf, 1], [1], ["bad", 1]]:
        with pytest.raises(InvalidPredictions):
            regression_metric("rmse-v1", [1, 2], predictions)
    for labels in [[np.inf, 1], [], ["bad", 1]]:
        with pytest.raises(MetricUndefined):
            regression_metric("rmse-v1", labels, [1, 2])
    with pytest.raises(MetricUndefined, match="overflow"):
        regression_metric("rmse-v1", [1e308, 1], [-1e308, 2])
    with pytest.raises(MetricUndefined, match="overflow"):
        regression_metric("smape-ds-v1", [1e308], [1e308])
    with pytest.raises(MetricUndefined, match="overflow"):
        regression_metric("r2-sklearn-v1", [1e308, -1e308], [1e308, -1e308])


def binary_target(name="target"):
    return {
        "name": name,
        "classes": ["01", "1"],
        "positive_class": "01",
        "levels": None,
    }


def test_positive_class_ties_gini_order_and_logloss_rules():
    target = binary_target()
    labels = ["01", "1", "01", "1"]
    probability = [[0.8, 0.2], [0.8, 0.2], [0.4, 0.6], [0.1, 0.9]]
    assert (
        classification_metric("roc-auc-v1", target, labels, proba=probability) == 0.625
    )
    tied = [[0.5, 0.5]] * 4
    assert classification_metric("roc-auc-v1", target, labels, proba=tied) == 0.5
    assert (
        classification_metric("normalized-gini-ds-v1", target, labels, proba=tied)
        == 0.5
    )
    assert (
        classification_metric("normalized-gini-ds-v1", target, labels[::-1], proba=tied)
        == -0.5
    )
    with pytest.raises(MetricUndefined):
        classification_metric("roc-auc-v1", target, ["01"] * 4, proba=tied)
    zero = [[0, 1], [1, 0]]
    value = classification_metric(
        "log-loss-sklearn-v1", target, ["01", "1"], proba=zero
    )
    assert value == pytest.approx(-math.log(np.finfo(float).eps))
    assert zero == [[0, 1], [1, 0]]
    with pytest.raises(MetricUndefined):
        classification_metric(
            "log-loss-sklearn-inferred-binary-v1", target, ["01", "01"], proba=zero
        )


def test_label_metrics_and_nonuniform_kappa_coordinates():
    target = {
        "name": "quality",
        "classes": ["3", "5", "8"],
        "levels": [3, 5, 8],
        "positive_class": None,
    }
    actual, predicted = ["3", "5", "8", "8"], ["3", "8", "5", "8"]
    assert classification_metric("accuracy-v1", target, actual, predicted) == 0.5
    assert classification_metric("micro-f1-v1", target, actual, predicted) == 0.5
    from sklearn.metrics import cohen_kappa_score

    result = classification_metric("quadratic-kappa-ds10-v1", target, actual, predicted)
    assert result == pytest.approx(
        cohen_kappa_score(
            [3, 5, 8, 8], [3, 8, 5, 8], labels=list(range(10)), weights="quadratic"
        )
    )
    assert result != pytest.approx(
        cohen_kappa_score([0, 1, 2, 2], [0, 2, 1, 2], weights="quadratic")
    )
    with pytest.raises(MetricUndefined, match="denominator"):
        classification_metric("quadratic-kappa-ds10-v1", target, ["3", "3"], ["3", "3"])


def test_top3_hit_has_no_position_weights_but_keeps_ranking_semantics():
    target = {
        "name": "target",
        "classes": ["a", "b", "c", "d"],
        "positive_class": None,
        "levels": None,
    }
    for candidates in [["a", "b", "c"], ["c", "b", "a"], ["a"]]:
        assert (
            classification_metric("top3-hit-ds-v1", target, ["a"], ranked=[candidates])
            == 1
        )
    assert (
        classification_metric("top3-hit-ds-v1", target, ["a"], ranked=[["b", "c", "d"]])
        == 0
    )
    for candidates in [[], ["a", "a"], ["z"], ["a", "b", "c", "d"]]:
        with pytest.raises(InvalidPredictions):
            classification_metric("top3-hit-ds-v1", target, ["a"], ranked=[candidates])
    assert (
        classification_metric(
            "top3-hit-ds-v1",
            target,
            ["a"],
            proba=[[0.25] * 4],
            ranked=[["a", "b", "c"]],
        )
        == 1
    )
    with pytest.raises(InvalidPredictions, match="disagree"):
        classification_metric(
            "top3-hit-ds-v1",
            target,
            ["a"],
            proba=[[0.25] * 4],
            ranked=[["c", "b", "a"]],
        )


def test_multilabel_probabilities_are_independent_and_undefined_targets_fail_all():
    targets = [binary_target(f"t{i}") for i in range(7)]
    actual = {t["name"]: ["01", "1"] for t in targets}
    probability = {t["name"]: [[0.9, 0.1], [0.1, 0.9]] for t in targets}
    result = mean_target_auc(targets, actual, probability)
    assert result["value"] == 1
    assert len(result["targets"]) == 7
    actual["t3"] = ["01", "01"]
    with pytest.raises(MetricUndefined) as caught:
        mean_target_auc(targets, actual, probability)
    assert len(caught.value.diagnostics) == 7
    assert caught.value.diagnostics[3]["value"] is None
    assert caught.value.diagnostics[0]["value"] == 1
    with pytest.raises(InvalidPredictions, match="targets"):
        mean_target_auc(targets, actual, {"t0": probability["t0"]})


@pytest.mark.parametrize(
    "probability", [[[1.1, -0.1]], [[0.2, 0.2]], [[math.nan, 1]], [[0.1, 0.2, 0.7]]]
)
def test_invalid_probabilities_never_repaired(probability):
    with pytest.raises(InvalidPredictions):
        classification_metric(
            "log-loss-sklearn-v1", binary_target(), ["01"], proba=probability
        )
