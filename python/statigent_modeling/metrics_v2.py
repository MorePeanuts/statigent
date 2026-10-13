"""可信 V2 指标计算；输入仅为标签/预测数组，不导入候选或反序列化模型。"""

import math

import numpy as np
from sklearn.metrics import (
    f1_score,
    log_loss,
    mean_squared_log_error,
    r2_score,
    roc_auc_score,
)

from .protocol import probabilities


class InvalidPredictions(ValueError):
    """模型输出违反已冻结契约。"""


class MetricUndefined(ValueError):
    """评分材料或公式未定义，不能解释为模型得到零分。"""

    def __init__(self, message, diagnostics=None):
        super().__init__(message)
        self.diagnostics = diagnostics


def finite_result(value):
    value = float(value)
    if not math.isfinite(value):
        raise MetricUndefined("Metric is non-finite/overflowed")
    return value


def numeric_vectors(actual, predicted):
    try:
        actual = np.asarray(actual, dtype=np.float64)
    except (ValueError, TypeError) as error:
        raise MetricUndefined("Invalid numeric labels") from error
    if actual.ndim != 1 or not len(actual) or not np.isfinite(actual).all():
        raise MetricUndefined("Empty/invalid/non-finite numeric labels")
    try:
        predicted = np.asarray(predicted, dtype=np.float64)
    except (ValueError, TypeError) as error:
        raise InvalidPredictions("Invalid numeric predictions") from error
    if predicted.shape != actual.shape or not np.isfinite(predicted).all():
        raise InvalidPredictions("Invalid prediction shape/non-finite values")
    return actual, predicted


def regression_metric(identity, actual, predicted):
    actual, predicted = numeric_vectors(actual, predicted)
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        if identity == "rmse-v1":
            value = np.sqrt(np.mean((actual - predicted) ** 2))
        elif identity == "mae-v1":
            value = np.mean(np.abs(actual - predicted))
        elif identity == "median-absolute-error-v1":
            value = np.median(np.abs(actual - predicted))
        elif identity in (
            "rmsle-numpy-log-v1",
            "rmsle-numpy-log1p-v1",
            "rmsle-sklearn-v1",
        ):
            # 固定 sklearn 1.7.2 已允许 (-1, 0)；不套用旧版的非负域。
            if (actual <= -1).any():
                raise MetricUndefined("RMSLE labels outside frozen domain")
            if (predicted <= -1).any():
                raise InvalidPredictions("RMSLE predictions outside frozen domain")
            if identity == "rmsle-sklearn-v1":
                value = np.sqrt(mean_squared_log_error(actual, predicted))
            else:
                a, b = (
                    (np.log(actual + 1), np.log(predicted + 1))
                    if identity == "rmsle-numpy-log-v1"
                    else (np.log1p(actual), np.log1p(predicted))
                )
                value = np.sqrt(np.mean((a - b) ** 2))
        elif identity == "r2-sklearn-v1":
            if len(actual) < 2:
                raise MetricUndefined("R2 needs at least two labels")
            if not (
                np.isfinite(np.sum((actual - predicted) ** 2))
                and np.isfinite(np.sum((actual - np.mean(actual)) ** 2))
            ):
                raise MetricUndefined("R2 variance/residual overflow")
            value = r2_score(actual, predicted, force_finite=True)
        elif identity in ("smape-ds-v1", "smape-zero-v1"):
            denominator = np.abs(actual) + np.abs(predicted)
            if not np.isfinite(denominator).all():
                raise MetricUndefined("SMAPE denominator overflow")
            if identity == "smape-ds-v1":
                if (denominator == 0).any():
                    raise MetricUndefined("DSBench SMAPE double zero is undefined")
                terms = 2 * np.abs(predicted - actual) / denominator
            else:
                terms = np.divide(
                    2 * np.abs(predicted - actual),
                    denominator,
                    out=np.zeros_like(actual),
                    where=denominator != 0,
                )
            value = np.mean(terms)
        else:
            raise ValueError(f"Unknown regression metric: {identity}")
    return finite_result(value)


def class_vectors(target, actual, predicted=None):
    classes = target["classes"]
    if (
        not isinstance(actual, (list, np.ndarray))
        or not len(actual)
        or any(v not in classes for v in actual)
    ):
        raise MetricUndefined("Missing/unknown classification labels")
    y = np.array([classes.index(v) for v in actual], dtype=np.int64)
    if predicted is not None:
        if len(predicted) != len(actual) or any(v not in classes for v in predicted):
            raise InvalidPredictions("Invalid predicted labels")
        predicted = np.array([classes.index(v) for v in predicted], dtype=np.int64)
    return y, predicted


def normalized_gini(actual, predicted):
    """发布版本：预测降序，同分按固定评价成员顺序；不替换为 2*AUC-1。"""
    if len(np.unique(actual)) != 2:
        raise MetricUndefined("Gini requires both classes")

    def gini(scores):
        order = np.lexsort((np.arange(len(actual)), -scores))
        total = actual[order].cumsum().sum() / actual.sum()
        return (total - (len(actual) + 1) / 2) / len(actual)

    denominator = gini(actual)
    if denominator == 0:
        raise MetricUndefined("Gini denominator is zero")
    return finite_result(gini(predicted) / denominator)


def quadratic_kappa(target, actual, predicted):
    levels = target["levels"]
    actual = np.asarray([levels[v] for v in actual])
    predicted = np.asarray([levels[v] for v in predicted])
    observed = np.zeros((10, 10), dtype=np.int64)
    np.add.at(observed, (actual, predicted), 1)
    weight = (np.arange(10)[:, None] - np.arange(10)[None, :]) ** 2 / 81
    expected = np.outer(
        np.bincount(actual, minlength=10), np.bincount(predicted, minlength=10)
    )
    expected = expected / expected.sum() * observed.sum()
    denominator = (weight * expected).sum()
    if denominator == 0:
        raise MetricUndefined("Kappa denominator is zero")
    return finite_result(1 - (weight * observed).sum() / denominator)


def validate_classification_predictions(
    target, rows, predicted=None, proba=None, ranked=None
):
    """只校验公开预测契约，不读取或伪造评价标签。"""
    classes = target["classes"]
    predicted_indices = None
    if predicted is not None:
        if len(predicted) != rows or any(v not in classes for v in predicted):
            raise InvalidPredictions("Invalid predicted labels")
        predicted_indices = np.array([classes.index(v) for v in predicted])
    probability = None
    if proba is not None:
        try:
            probability = probabilities(proba, rows, len(classes))
        except (ValueError, TypeError) as error:
            raise InvalidPredictions(str(error)) from error
        if predicted_indices is not None and not np.array_equal(
            predicted_indices, np.argmax(probability, axis=1)
        ):
            raise InvalidPredictions("Probability label mismatch")
    if ranked is not None:
        if not isinstance(ranked, list) or len(ranked) != rows:
            raise InvalidPredictions("Invalid ranked predictions")
        for i, candidates in enumerate(ranked):
            if (
                not isinstance(candidates, list)
                or not 1 <= len(candidates) <= min(3, len(classes))
                or any(not isinstance(v, str) or v not in classes for v in candidates)
                or len(set(candidates)) != len(candidates)
            ):
                raise InvalidPredictions("Invalid/duplicate/unknown ranked labels")
            if probability is not None:
                expected = [
                    classes[j]
                    for j in np.argsort(-probability[i], kind="stable")[
                        : len(candidates)
                    ]
                ]
                if candidates != expected:
                    raise InvalidPredictions(
                        "Ranked labels disagree with probabilities"
                    )
    return predicted_indices, probability


def classification_metric(
    identity, target, actual, predicted=None, proba=None, ranked=None
):
    y, _ = class_vectors(target, actual)
    predicted_indices, probability = validate_classification_predictions(
        target, len(y), predicted, proba, ranked
    )
    classes = target["classes"]
    if identity == "top3-hit-ds-v1":
        if ranked is None:
            raise InvalidPredictions("Invalid ranked predictions")
        return sum(
            label in candidates
            for label, candidates in zip(actual, ranked, strict=True)
        ) / len(y)
    if identity in ("accuracy-v1", "micro-f1-v1", "quadratic-kappa-ds10-v1"):
        if predicted_indices is None:
            raise InvalidPredictions("Missing label predictions")
        if identity == "accuracy-v1":
            return float(np.mean(y == predicted_indices))
        if identity == "micro-f1-v1":
            return finite_result(f1_score(y, predicted_indices, average="micro"))
        return quadratic_kappa(target, y, predicted_indices)
    if probability is None:
        raise InvalidPredictions("Missing probability predictions")
    if identity in (
        "roc-auc-v1",
        "normalized-gini-ds-v1",
        "log-loss-sklearn-inferred-binary-v1",
    ):
        if len(classes) != 2 or target["positive_class"] not in classes:
            raise ValueError("Invalid binary target")
        positive_index = classes.index(target["positive_class"])
        binary = (y == positive_index).astype(np.int64)
        if len(np.unique(binary)) != 2:
            raise MetricUndefined("Metric requires both evaluation classes")
        scores = probability[:, positive_index]
        if identity == "roc-auc-v1":
            return finite_result(roc_auc_score(binary, scores))
        if identity == "normalized-gini-ds-v1":
            return normalized_gini(binary, scores)
        return finite_result(log_loss(binary, scores))
    if identity == "log-loss-sklearn-v1":
        return finite_result(log_loss(y, probability, labels=np.arange(len(classes))))
    raise ValueError(f"Unknown classification metric: {identity}")


def mean_target_auc(targets, actual, probability):
    names = [target["name"] for target in targets]
    if set(actual) != set(names):
        raise MetricUndefined("Missing/extra label targets")
    if set(probability) != set(names):
        raise InvalidPredictions("Missing/extra prediction targets")
    if len({len(actual[name]) for name in names}) != 1:
        raise MetricUndefined("Target row counts differ")
    diagnostics = []
    for target in targets:
        name = target["name"]
        try:
            value = classification_metric(
                "roc-auc-v1", target, actual[name], proba=probability[name]
            )
            diagnostics.append(
                {"target": name, "metric": "roc-auc-v1", "value": value, "error": None}
            )
        except MetricUndefined as error:
            diagnostics.append(
                {
                    "target": name,
                    "metric": "roc-auc-v1",
                    "value": None,
                    "error": str(error),
                }
            )
    if any(d["error"] for d in diagnostics):
        raise MetricUndefined("Mean target AUC has undefined targets", diagnostics)
    return {
        "value": finite_result(np.mean([d["value"] for d in diagnostics])),
        "targets": diagnostics,
    }
