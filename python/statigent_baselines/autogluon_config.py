"""固定 CPU 方法配置；不能在运行时隐式换模型集合或下载预训练权重。"""

from copy import deepcopy

MODEL_FAMILIES = ("GBM", "CAT", "XGB", "RF", "XT", "NN_TORCH")


def fit_parameters(time_limit: float, cpus: int):
    if time_limit <= 0 or cpus < 1:
        raise ValueError("Positive training time and CPU allowance required")
    return {
        "presets": "best_quality",
        "hyperparameters": {name: {} for name in MODEL_FAMILIES},
        "auto_stack": True,
        "num_bag_folds": 5,
        "num_bag_sets": 1,
        "num_stack_levels": 1,
        "dynamic_stacking": False,
        "fit_strategy": "sequential",
        "ag_args_ensemble": {"fold_fitting_strategy": "sequential_local"},
        "num_cpus": cpus,
        "num_gpus": 0,
        "time_limit": time_limit,
    }


def expanded_fit_parameters(parameters):
    from autogluon.tabular.configs.presets_configs import tabular_presets_dict

    effective = deepcopy(tabular_presets_dict["best_quality"])
    effective.update(deepcopy(parameters))
    return effective
