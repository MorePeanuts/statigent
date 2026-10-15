"""小型真实训练环境探针；缩小树数/轮次，不作为研究效果验收。"""

import json
import random
import tempfile
import time
from importlib.metadata import version
from pathlib import Path

import catboost
import lightgbm
import numpy as np
import pandas as pd
import torch
import xgboost
from autogluon.tabular import TabularPredictor
from autogluon_config import MODEL_FAMILIES, expanded_fit_parameters, fit_parameters


def main():
    random.seed(7)
    np.random.seed(7)
    torch.manual_seed(7)
    torch.set_num_threads(2)
    rng = np.random.default_rng(7)
    x = rng.normal(size=(120, 3))
    data = pd.DataFrame(x, columns=["a", "b", "c"])
    data["y"] = 2 * x[:, 0] - x[:, 1] + 0.1 * rng.normal(size=120)
    parameters = fit_parameters(120, 2)
    # 只减小合成探针的计算量；保持声明的全部模型家族和 bag/stack/ensemble。
    probe_parameters = dict(parameters)
    probe_parameters.update(num_bag_folds=2)
    probe_parameters["hyperparameters"] = {
        "GBM": {"num_boost_round": 5},
        "CAT": {"iterations": 5},
        "XGB": {"n_estimators": 5},
        "RF": {"n_estimators": 5},
        "XT": {"n_estimators": 5},
        "NN_TORCH": {"num_epochs": 2},
    }
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="statigent-autogluon-probe-") as temp:
        path = str(Path(temp) / "model")
        predictor = TabularPredictor(
            label="y",
            problem_type="regression",
            eval_metric="root_mean_squared_error",
            path=path,
            verbosity=1,
            learner_kwargs={"random_state": 7},
        ).fit(data, **probe_parameters)
        features = data.drop(columns="y").iloc[:7].copy()
        expected = predictor.predict(features).to_numpy()
        predictor.save(silent=True)
        loaded = TabularPredictor.load(path)
        actual = loaded.predict(features).to_numpy()
        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12)
        assert np.isfinite(actual).all()
        models = loaded.model_names()
        types = {v["model_type"] for v in loaded.info()["model_info"].values()}
        # 验证六类实际模型训练成功，不能把导入成功误记为模型训练成功。
        prefixes = (
            "LightGBM",
            "CatBoost",
            "XGBoost",
            "RandomForest",
            "ExtraTrees",
            "NeuralNetTorch",
        )
        for prefix in prefixes:
            if not any(name.startswith(prefix) for name in models):
                raise RuntimeError(f"Declared family did not fit: {prefix}; {models}")
        print(
            json.dumps(
                {
                    "method": "autogluon",
                    "version": version("autogluon.tabular"),
                    "dependencies": {
                        "lightgbm": lightgbm.__version__,
                        "catboost": catboost.__version__,
                        "xgboost": xgboost.__version__,
                        "torch": torch.__version__,
                    },
                    "model_families": MODEL_FAMILIES,
                    "effective_config": expanded_fit_parameters(parameters),
                    "probe_overrides": probe_parameters,
                    "trained_models": models,
                    "model_types": sorted(types),
                    "prediction_reloaded_equal": True,
                    "model_calls": 0,
                    "wall_ms": (time.monotonic() - started) * 1000,
                }
            )
        )


if __name__ == "__main__":
    main()
