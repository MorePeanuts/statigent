"""显式零 LLM system 示例；小型合成数据，失败保留且不自动重试。"""

import argparse
import json
from pathlib import Path


def main():
    import pandas as pd
    from autogluon.core.metrics import get_metric

    from .tabarena_system import StatigentSystem

    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--runs", required=True, type=Path)
    parser.add_argument(
        "--kind", required=True, choices=["regression", "binary", "multiclass"]
    )
    args = parser.parse_args()
    if args.config.stat().st_size > 1024**2:
        raise ValueError("Config limit")
    config = json.loads(args.config.read_bytes())
    if config.get("mode") != "deterministic":
        raise ValueError("This verification entry only accepts deterministic mode")
    kind = args.kind
    labels = (
        [0.0, 1.0, 2.0]
        if kind == "regression"
        else ["01", "1"]
        if kind == "binary"
        else ["z", "01", "a"]
    )
    X = pd.DataFrame(
        {
            "number": [i % len(labels) for i in range(60)],
            "text": ["01", "NA", "类别"] * 20,
        }
    )
    y = pd.Series([labels[i % len(labels)] for i in range(60)], name="outcome")
    metric = {"regression": "rmse", "binary": "roc_auc", "multiclass": "log_loss"}[kind]
    model = StatigentSystem(
        **config,
        run_root=args.runs,
        problem_type=kind,
        eval_metric=get_metric(metric, kind),
        validation_metadata={"target_name": "outcome"},
        fit_kwargs={"num_cpus": 1, "num_gpus": 0, "memory_limit": 2, "time_limit": 300},
    )
    try:
        model.fit(X, y)
        first = (
            model.predict(X.iloc[:6])
            if kind == "regression"
            else model.predict_proba(X.iloc[:6])
        )
        second = (
            model.predict(X.iloc[:6])
            if kind == "regression"
            else model.predict_proba(X.iloc[:6])
        )
        if not first.equals(second):
            raise ValueError("Frozen model predictions differ")
        report = {
            "version": 1,
            "status": "passed",
            "scope": "official-system-synthetic",
            "kind": kind,
            "directory": str(model.directory),
            "live_llm_calls": 0,
            "fit": model.fit_response,
            "prediction_records": model.prediction_records,
            "research_experiment": False,
        }
        path = model.directory / "system-verification.json"
        path.write_text(json.dumps(report, ensure_ascii=False))
        print(
            json.dumps({"status": "passed", "report": str(path), "live_llm_calls": 0})
        )
    finally:
        model.cleanup()


if __name__ == "__main__":
    main()
