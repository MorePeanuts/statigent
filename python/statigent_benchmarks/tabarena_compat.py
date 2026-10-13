"""显式官方环境探针；默认测试/智能体运行不导入 TabArena。"""

import hashlib
import inspect
import json
from importlib.metadata import version
from pathlib import Path


def verify_environment() -> dict:
    from tabarena.benchmark.exec_models import ExternalSystemModel

    root = Path(__file__).resolve().parents[2]
    manifest = json.loads(
        (
            root / "src/evaluation/benchmarks/modeling/tabarena-provenance.json"
        ).read_text()
    )
    lock = root / "environments/tabarena/uv.lock"
    if (
        hashlib.sha256(lock.read_bytes()).hexdigest()
        != manifest["environment_lock_sha256"]
    ):
        raise ValueError("Official environment lock mismatch")
    if any(
        version(name) != expected
        for name, expected in manifest["metric_dependencies"].items()
    ):
        raise ValueError("Official metric dependencies drift")
    parameters = list(inspect.signature(ExternalSystemModel._fit_system).parameters)
    if parameters != manifest["fit_parameters"]:
        raise ValueError("Official system signature drift")
    source_file = inspect.getsourcefile(ExternalSystemModel)
    if source_file is None:
        raise ValueError("Official source not available")
    package_root = Path(source_file).parents[2]
    for resource in manifest["resources"]:
        relative = resource["path"].split("packages/tabarena/src/tabarena/", 1)[1]
        if (
            hashlib.sha256((package_root / relative).read_bytes()).hexdigest()
            != resource["sha256"]
        ):
            raise ValueError(f"Official code hash mismatch: {relative}")
    return manifest


def verify() -> dict:
    import numpy as np
    import pandas as pd
    from autogluon.core.data.label_cleaner import LabelCleaner
    from autogluon.core.metrics import get_metric
    from tabarena.benchmark.exec_models import ExternalSystemModel
    from tabarena.benchmark.experiment.experiment_runner import evaluate

    manifest = verify_environment()

    class Probe(ExternalSystemModel):
        def _fit_system(self, X, y, **kwargs):
            self.received = (X.copy(), y.copy(), kwargs)
            self.classes = list(pd.unique(y))
            return self

        def _predict_proba(self, X):
            return pd.DataFrame(
                np.tile([0.75, 0.25], (len(X), 1)), index=X.index, columns=self.classes
            )

    X = pd.DataFrame({"feature": [1, 2, 3, 4]})
    # 保留数字外观字符串，探针不拟合真实模型、不发起网络请求。
    y = pd.Series(["01", "1", "01", "1"], name="target")
    model = Probe(
        problem_type="binary",
        eval_metric=get_metric("roc_auc", "binary"),
        validation_metadata={"target_name": "target"},
        fit_kwargs={"num_cpus": 1, "num_gpus": 0, "memory_limit": 1, "time_limit": 10},
    )
    model.fit(X, y)
    received_x, received_y, kwargs = model.received
    assert received_x.equals(X) and received_y.equals(y)
    assert kwargs["target_name"] == "target"
    assert kwargs["num_cpus"] == 1 and kwargs["num_gpus"] == 0
    assert kwargs["memory_limit"] == 1 and kwargs["time_limit"] == 10
    assert kwargs["random_state"] is None
    probabilities = model.predict_proba(X.iloc[:2])
    assert list(probabilities.columns) == ["01", "1"]
    cleaner = LabelCleaner.construct(problem_type="binary", y=y)
    binary_error = evaluate(
        y, y, model.predict_proba(X), get_metric("roc_auc", "binary"), "binary", cleaner
    )
    assert abs(binary_error - 0.5) < 1e-12
    rmse = evaluate(
        pd.Series([1.0, 3.0]),
        pd.Series([2.0, 2.0]),
        None,
        get_metric("rmse", "regression"),
        "regression",
    )
    assert abs(rmse - 1) < 1e-12
    multi_y = pd.Series(["z", "01", "a"])
    multi_cleaner = LabelCleaner.construct(problem_type="multiclass", y=multi_y)
    multi_proba = pd.DataFrame(
        0.1, index=multi_y.index, columns=multi_cleaner.ordered_class_labels
    )
    for index, label in multi_y.items():
        multi_proba.loc[index, label] = 0.8
    logloss = evaluate(
        multi_y,
        multi_y,
        multi_proba,
        get_metric("log_loss", "multiclass"),
        "multiclass",
        multi_cleaner,
    )
    assert abs(logloss + np.log(0.8)) < 1e-12
    model.cleanup()
    return {
        "schema_version": 1,
        "code_commit": manifest["code_commit"],
        "status": "passed",
        "scope": "official-interface-and-metric-probe",
        "llm_calls": 0,
        "model_fits": 0,
        "system_fit_calls": 1,
        "dependencies": {
            name: version(name)
            for name in [
                "tabarena",
                "bencheval",
                "autogluon.core",
                "numpy",
                "pandas",
                "scikit-learn",
                "scipy",
            ]
        },
        "binary_class_mapping": {str(k): int(v) for k, v in cleaner.inv_map.items()},
        "metric_errors": {
            "rmse": float(rmse),
            "roc_auc": float(binary_error),
            "log_loss": float(logloss),
        },
        "statigent_wrapper": "separate_explicit_verification",
        "real_tasks": "not_run",
    }


if __name__ == "__main__":
    print(json.dumps(verify(), ensure_ascii=False, indent=2))
