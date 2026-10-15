"""版本化内部选择映射；只依赖公开指标核心，不读取基准评分材料。"""

import warnings
from functools import partial

import numpy as np
from statigent_modeling.metrics_v2 import classification_metric, regression_metric
from statigent_modeling.protocol_v2 import metric_definition

NATIVE = {
    "rmse-v1": "root_mean_squared_error",
    "mae-v1": "mean_absolute_error",
    "median-absolute-error-v1": "median_absolute_error",
    "r2-sklearn-v1": "r2",
    "accuracy-v1": "accuracy",
    "micro-f1-v1": "accuracy",
    "roc-auc-v1": "roc_auc",
    "mean-target-auc-v1": "roc_auc",
}
CUSTOM = {
    "rmsle-numpy-log-v1",
    "rmsle-numpy-log1p-v1",
    "rmsle-sklearn-v1",
    "smape-ds-v1",
    "smape-zero-v1",
    "normalized-gini-ds-v1",
    "quadratic-kappa-ds10-v1",
    "top3-hit-ds-v1",
    "log-loss-sklearn-inferred-binary-v1",
    "log-loss-sklearn-v1",
}


def score_encoded(actual, predicted, *, identity, target):
    if not target["classes"]:
        return regression_metric(identity, actual, predicted)
    classes = target["classes"]
    labels = [classes[int(index)] for index in actual]
    if identity in ("accuracy-v1", "micro-f1-v1", "quadratic-kappa-ds10-v1"):
        return classification_metric(
            identity,
            target,
            labels,
            predicted=[classes[int(index)] for index in predicted],
        )
    probability = np.asarray(predicted, dtype=float)
    if probability.ndim == 1:
        probability = np.column_stack([1 - probability, probability])
    if probability.shape != (len(labels), len(classes)):
        raise ValueError("AutoGluon encoded probability shape mismatch")
    ranked = None
    if identity == "top3-hit-ds-v1":
        ranked = [
            [classes[int(index)] for index in row]
            for row in np.argsort(-probability, axis=1, kind="stable")[:, :3]
        ]
    with warnings.catch_warnings():
        # float32 模型概率转成冻结 float64 公式时会反复产生此精度提示。
        # 公开核心仍校验 1e-6 概率和约束；不改变概率或指标数值。
        warnings.filterwarnings(
            "ignore",
            message="The y_prob values do not sum to one.*",
            category=UserWarning,
        )
        return classification_metric(
            "roc-auc-v1" if identity == "mean-target-auc-v1" else identity,
            target,
            labels,
            proba=probability,
            ranked=ranked,
        )


def checked_native(actual, predicted, *, identity, target, native):
    # 原生指标的 NaN/单类行为不一定等于冻结协议；先执行同一域校验。
    score_encoded(actual, predicted, identity=identity, target=target)
    return native.convert_score_to_original(native(actual, predicted))


def scorer(identity, target, kind):
    from autogluon.core.metrics import get_metric, make_scorer

    definition = metric_definition(identity)
    if identity in NATIVE:
        # 内部二分类编码强制以协议正类为 1；否则原生 AUC 的方向不等价。
        native = get_metric(
            NATIVE[identity],
            problem_type="regression"
            if kind == "regression"
            else "binary"
            if kind in ("binary", "multilabel")
            else "multiclass",
        )
        return make_scorer(
            name=f"statigent-{identity}",
            score_func=partial(
                checked_native, identity=identity, target=target, native=native
            ),
            optimum=native.optimum,
            greater_is_better=definition["direction"] == "maximize",
            needs_proba=native.needs_proba,
            needs_threshold=native.needs_threshold,
            needs_class=native.needs_class,
        )
    if identity not in CUSTOM:
        raise ValueError("Unknown baseline metric ID")
    probabilities = identity in (
        "normalized-gini-ds-v1",
        "top3-hit-ds-v1",
        "log-loss-sklearn-inferred-binary-v1",
        "log-loss-sklearn-v1",
    )
    return make_scorer(
        name=f"statigent-{identity}",
        score_func=partial(score_encoded, identity=identity, target=target),
        optimum=1 if definition["direction"] == "maximize" else 0,
        greater_is_better=definition["direction"] == "maximize",
        needs_proba=probabilities,
        needs_class=bool(target["classes"]) and not probabilities,
    )
