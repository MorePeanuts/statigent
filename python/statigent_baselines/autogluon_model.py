"""CPU AutoML 训练/预测胶水；外层流程和总预算由 TypeScript 管理。"""

import json
import random
import time
from pathlib import Path

import numpy as np
import pandas as pd
from statigent_modeling.data_v3 import decode_cell
from statigent_modeling.protocol_v2 import prediction_columns_v2, validate_protocol_v2

from statigent_baselines.autogluon_config import expanded_fit_parameters, fit_parameters
from statigent_baselines.autogluon_metrics import scorer


def encoded_target(target):
    classes = target["classes"]
    if target["positive_class"] is not None:
        positive = target["positive_class"]
        classes = [c for c in classes if c != positive] + [positive]
    return {**target, "classes": classes}


def feature_frame(frame, schema, features):
    result = pd.DataFrame(index=frame.index)
    columns = {c["name"]: c for c in schema["columns"]}
    for name in features:
        values = frame[name].map(decode_cell)
        result[name] = (
            pd.to_numeric(values, errors="raise")
            if columns[name]["kind"] == "numeric"
            else values
        )
    return result


def train(manifest_path, destination, time_limit, cpus, seed):
    from autogluon.tabular import TabularPredictor

    started = time.monotonic()
    if time_limit <= 0 or cpus < 1:
        raise ValueError("Positive shared AutoML allowance required")
    manifest_path, destination = Path(manifest_path), Path(destination)
    manifest = json.loads(manifest_path.read_text())
    protocol = validate_protocol_v2(manifest["protocol"])
    if set(protocol["feature_columns"]) & {t["name"] for t in protocol["targets"]}:
        raise ValueError("Targets cannot be features")
    schema = json.loads(
        (manifest_path.parent / manifest["feature_schema"]["path"]).read_text()
    )
    frame = pd.read_csv(
        manifest_path.parent / manifest["training"]["path"],
        dtype=str,
        keep_default_na=False,
    )
    features = feature_frame(frame, schema, protocol["feature_columns"])
    destination.mkdir(parents=True, exist_ok=False)
    targets, runs = protocol["targets"], []
    for index, target in enumerate(targets):
        allowance = (time_limit - (time.monotonic() - started)) / (len(targets) - index)
        if allowance <= 0:
            raise TimeoutError("Shared training budget exhausted before all targets")
        random.seed(seed + index)
        np.random.seed((seed + index) % 2**32)
        encoded = encoded_target(target)
        values = frame[target["name"]].map(decode_cell)
        if not encoded["classes"]:
            label = pd.to_numeric(values, errors="raise")
            problem = "regression"
        else:
            if set(values) != set(encoded["classes"]):
                raise ValueError("Missing/unknown training classes")
            if protocol["output"] == "ranked-labels" and len(encoded["classes"]) < 3:
                raise ValueError("Three distinct classes required")
            label = values.map({c: i for i, c in enumerate(encoded["classes"])})
            problem = "binary" if len(encoded["classes"]) == 2 else "multiclass"
        data = features.copy()
        # 独立目标表只含公开特征和当前标签，其他标签从不进入 Predictor。
        data[target["name"]] = label
        model_path = destination / f"target-{index}"
        predictor = TabularPredictor(
            label=target["name"],
            problem_type=problem,
            eval_metric=scorer(protocol["metric"]["id"], encoded, protocol["kind"]),
            path=str(model_path),
            verbosity=0,
            learner_kwargs={"random_state": seed + index, "cache_data": False},
            **({"positive_class": 1} if problem == "binary" else {}),
        )
        # fit 的软时限先于硬截止，为序列化、清理缓存和多目标交接留出时间。
        parameters = fit_parameters(allowance - min(10, allowance * 0.2), cpus)
        target_start = time.monotonic()
        predictor.fit(data, **parameters)
        if not predictor.model_names():
            raise RuntimeError("No fitted AutoGluon model")
        # 预测 bundle 不携带显式训练表/标签缓存或继续拟合所需的 OOF 材料。
        predictor.save_space(remove_data=True, remove_fit_stack=True)
        runs.append(
            {
                "target": target["name"],
                "encoded": encoded,
                "path": f"target-{index}",
                "seed": seed + index,
                "training_cache": "removed",
                "allowance_seconds": allowance,
                "fit_time_limit_seconds": parameters["time_limit"],
                "elapsed_seconds": time.monotonic() - target_start,
                "effective_parameters": expanded_fit_parameters(parameters),
                "models": predictor.model_names(),
                "selected_model": predictor.model_best,
            }
        )
        (destination / "training.json").write_text(
            json.dumps(
                {"version": 1, "targets": runs, "complete": len(runs) == len(targets)},
                default=str,
            )
        )
    (destination / "schema.json").write_text(json.dumps(schema))
    (destination / "protocol.json").write_text(json.dumps(protocol))
    (destination / "predict.py").write_text(
        "from statigent_baselines.autogluon_model import predict_main\n"
        "if __name__ == '__main__': predict_main()\n"
    )
    return {
        "version": 1,
        "targets": runs,
        "elapsed_seconds": time.monotonic() - started,
        "model_calls": 0,
    }


def predict_main():
    import argparse

    from autogluon.tabular import TabularPredictor

    parser = argparse.ArgumentParser()
    for key in ("features", "output", "schema"):
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    root = Path.cwd()
    protocol = json.loads((root / "protocol.json").read_text())
    if json.loads(Path(args.schema).read_text())["protocol"] != protocol:
        raise ValueError("Frozen AutoGluon protocol mismatch")
    schema = json.loads((root / "schema.json").read_text())
    training = json.loads((root / "training.json").read_text())
    if not training["complete"] or len(training["targets"]) != len(protocol["targets"]):
        raise ValueError("Incomplete multi-target bundle")
    frame = pd.read_csv(args.features, dtype=str, keep_default_na=False)
    x = feature_frame(frame, schema, protocol["feature_columns"])
    result = {protocol["id_column"]: frame[protocol["id_column"]]}
    for target, spec, record in zip(
        protocol["targets"],
        protocol["prediction"]["targets"],
        training["targets"],
        strict=True,
    ):
        if record["target"] != target["name"]:
            raise ValueError("Target order changed")
        predictor = TabularPredictor.load(str(root / record["path"]))
        if not target["classes"]:
            result[spec["value_column"]] = predictor.predict(x).to_numpy()
            continue
        encoded = record["encoded"]["classes"]
        probability = predictor.predict_proba(x, as_pandas=True, as_multiclass=True)
        ordered = np.column_stack(
            [probability[encoded.index(c)].to_numpy() for c in target["classes"]]
        )
        if spec["value_column"]:
            # 统一冻结类别顺序打破并列。
            result[spec["value_column"]] = [
                target["classes"][int(i)] for i in np.argmax(ordered, axis=1)
            ]
        for index, column in enumerate(spec["probability_columns"]):
            result[column] = ordered[:, index]
        if spec["ranked_column"]:
            result[spec["ranked_column"]] = [
                json.dumps([target["classes"][int(i)] for i in row])
                for row in np.argsort(-ordered, axis=1, kind="stable")[:, :3]
            ]
    pd.DataFrame(result)[prediction_columns_v2(protocol)].to_csv(
        args.output, index=False
    )
