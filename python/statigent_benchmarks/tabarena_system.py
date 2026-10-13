"""固定官方 ExternalSystemModel 接口；只在显式可选环境中导入。"""

import csv
import json
import math
import time
from pathlib import Path
from uuid import uuid4

import pandas as pd
from autogluon.core.data.label_cleaner import LabelCleaner
from statigent_modeling.data_v3 import encode_cell, file_descriptor, prepare_rows
from statigent_modeling.limits import DEFAULT_DATA_LIMITS, validate_limits
from statigent_modeling.scoring_v2 import read_table
from tabarena.benchmark.exec_models import ExternalSystemModel

from .system_bridge import SystemBridge
from .tabarena_compat import verify_environment


class StatigentSystem(ExternalSystemModel):
    """配置与记录属于一次 system 实例，cleanup 仅取消自身活动执行并保留证据。"""

    def __init__(
        self,
        *,
        task_template,
        mode,
        run_root,
        prediction_timeout_seconds,
        models=None,
        data_limits=None,
        seed=42,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.compatibility = verify_environment()
        if mode not in ("deterministic", "live"):
            raise ValueError("Explicit system mode required")
        if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
            raise ValueError("Invalid default seed")
        if not 0 < prediction_timeout_seconds <= 86400:
            raise ValueError("Explicit prediction timeout required")
        self.repository = Path(__file__).resolve().parents[2]
        self.directory = Path(run_root).resolve() / str(uuid4())
        self.directory.mkdir(parents=True, exist_ok=False)
        self.template = json.loads(json.dumps(task_template))
        self.mode = mode
        self.models = None if models is None else str(Path(models).resolve())
        self.default_seed = seed
        self.prediction_timeout = prediction_timeout_seconds
        self.data_limits = validate_limits(
            DEFAULT_DATA_LIMITS.copy() if data_limits is None else data_limits
        )
        credentials = []
        if mode == "live":
            if self.models is None or Path(self.models).stat().st_size > 1024**2:
                raise ValueError("Live system requires a bounded models config")
            profiles = json.loads(Path(self.models).read_text())
            selected = {
                self.template["model_profile"],
                self.template.get("eda_profile", self.template["model_profile"]),
            }
            credentials = [p["api_key_env"] for p in profiles if p["id"] in selected]
        self.bridge = SystemBridge(
            self.repository, self.directory / "bridge", credentials
        )
        self.frozen_root = None
        self.closed = False
        self.fit_started = False
        self.prediction_records = []

    def _fit_system(
        self,
        X,
        y,
        *,
        target_name,
        problem_type,
        eval_metric,
        validation_metadata,
        num_cpus,
        num_gpus,
        memory_limit,
        time_limit,
        random_state,
    ):
        started = time.monotonic()
        if self.closed or self.fit_started:
            raise RuntimeError("System instance cannot refit or restart")
        self.fit_started = True
        if num_gpus not in (None, 0):
            raise ValueError("GPU execution is not supported")
        if num_cpus is not None and (type(num_cpus) is not int or num_cpus < 1):
            raise ValueError("Invalid CPU constraint")
        if memory_limit is not None and (
            not math.isfinite(memory_limit) or memory_limit * 10**9 < 512 * 1024**2
        ):
            raise ValueError("Insufficient system memory constraint")
        if time_limit is not None and (
            not math.isfinite(time_limit) or time_limit <= 0
        ):
            raise ValueError("Invalid fit time constraint")
        budget = dict(self.template.get("budget", {}))
        configured_seconds = budget.get("task_timeout_ms", 900000) / 1000
        deadline = (
            min(configured_seconds, time_limit)
            if time_limit is not None
            else configured_seconds
        )
        if not math.isfinite(deadline) or not 0 < deadline <= 86400:
            raise ValueError("Invalid bounded fit deadline")
        for field in ("group_on", "time_on", "group_time_on"):
            if getattr(validation_metadata, field, None) is not None:
                raise ValueError(f"Unsupported split semantics: {field}")
        stratify = getattr(validation_metadata, "stratify_on", None)
        if stratify is not None and (
            problem_type == "regression" or stratify != target_name
        ):
            raise ValueError("Unsupported custom stratification semantics")
        metric = {
            ("regression", "root_mean_squared_error"): "rmse-v1",
            ("regression", "rmse"): "rmse-v1",
            ("binary", "roc_auc"): "roc-auc-v1",
            ("multiclass", "log_loss"): "log-loss-sklearn-v1",
        }.get((problem_type, eval_metric.name))
        if metric is None:
            raise ValueError("Metric differs from frozen TabArena protocol")
        if (
            not X.index.equals(y.index)
            or not X.columns.is_unique
            or any(not isinstance(c, str) or not c.strip() for c in X.columns)
        ):
            raise ValueError("Unaligned training input or invalid columns")
        if (
            not isinstance(target_name, str)
            or not target_name.strip()
            or target_name in X
        ):
            raise ValueError("Invalid target name")
        if (
            len(X) > self.data_limits["max_rows"]
            or len(X.columns) + 2 > self.data_limits["max_columns"]
        ):
            raise ValueError("Input shape limit")
        if (
            int(X.memory_usage(deep=True).sum()) + int(y.memory_usage(deep=True))
            > self.data_limits["max_memory_bytes"]
        ):
            raise ValueError("Input memory limit")
        identity = "__statigent_row_id__"
        while identity in X or identity == target_name:
            identity += "_"
        self.raw_classes = (
            []
            if problem_type == "regression"
            else list(
                LabelCleaner.construct(
                    problem_type=problem_type, y=y
                ).ordered_class_labels
            )
        )
        classes = [str(c) for c in self.raw_classes] if self.raw_classes else None
        if classes and len(set(classes)) != len(classes):
            raise ValueError("Class string identities collide")
        self.features = [
            {
                "name": c,
                "kind": "numeric"
                if pd.api.types.is_numeric_dtype(X[c].dtype)
                and not pd.api.types.is_bool_dtype(X[c].dtype)
                else "string",
                "source_type": str(X[c].dtype),
                "categories": None,
            }
            for c in X.columns
        ]
        self.columns = list(X.columns)
        self.id_column = identity
        self.target = target_name
        seed = self.default_seed if random_state is None else random_state

        def rows():
            for i, (values, target) in enumerate(
                zip(X.itertuples(index=False, name=None), y, strict=True)
            ):
                if (
                    time.monotonic() - started >= deadline
                    or self.bridge.cancelled.is_set()
                ):
                    raise TimeoutError("System preparation deadline/cancellation")
                data = {
                    c: None if pd.isna(v) else v
                    for c, v in zip(self.columns, values, strict=True)
                }
                data[target_name] = None if pd.isna(target) else target
                yield f"train:{i}", i, data

        dataset = prepare_rows(
            self.directory / "prepared",
            kind=problem_type,
            metric_id=metric,
            id_column=identity,
            targets=[
                {
                    "name": target_name,
                    "classes": classes,
                    "positive_class": classes[1] if problem_type == "binary" else None,
                    "levels": None,
                }
            ],
            features=self.features,
            excluded_columns=[],
            train=rows(),
            prediction=None,
            labels=None,
            seed=seed,
            limits=self.data_limits,
            provenance={
                "source": "tabarena-system-raw-training",
                "external_hpo": False,
            },
        )
        self.protocol = dataset["protocol"]
        task = self.template.copy()
        task.update(
            schema_version=4,
            delivery_mode="fit_only",
            dataset_root=str(self.directory / "prepared"),
        )
        limits = dict(task.get("limits", {}))
        if num_cpus is not None:
            limits["cpus"] = min(limits.get("cpus", 1), num_cpus)
        if memory_limit is not None:
            limits["memory_bytes"] = min(
                limits.get("memory_bytes", 4 * 1024**3),
                math.floor(memory_limit * 10**9),
            )
        remaining = deadline - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError("System preparation exhausted fit time")
        budget["task_timeout_ms"] = math.floor(remaining * 1000)
        task.update(limits=limits, budget=budget)
        if self.mode == "deterministic":
            task.update(
                model_profile="deterministic-modeling-v1",
                eda_profile="deterministic-modeling-v1",
            )
        self.fit_response = self.bridge.call(
            "fit",
            timeout_seconds=remaining,
            run_root=str(self.directory / "native"),
            task=task,
            mode=self.mode,
            models=self.models,
        )
        result = self.fit_response["result"]
        if result["status"] != "model_frozen" or not self.fit_response["frozen_id"]:
            raise RuntimeError(f"System fit failed: {result['reason']}")
        self.frozen_root = Path(result["directory"]).resolve()
        if not self.frozen_root.is_relative_to(self.directory / "native"):
            raise ValueError("Unexpected frozen model path")
        (self.directory / "system.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "official_code_commit": self.compatibility["code_commit"],
                    "official_environment_lock_sha256": self.compatibility[
                        "environment_lock_sha256"
                    ],
                    "mode": self.mode,
                    "external_hpo": False,
                    "seed": seed,
                    "fit_elapsed_ms": (time.monotonic() - started) * 1000,
                    "fit_time_limit_seconds": deadline,
                    "prediction_timeout_seconds": self.prediction_timeout,
                    "official_resources": {
                        "num_cpus": num_cpus,
                        "memory_gb": memory_limit,
                        "num_gpus": num_gpus,
                    },
                    "task": task,
                    "fit": self.fit_response,
                    "protocol": self.protocol,
                },
                ensure_ascii=False,
            )
        )
        return self

    def _predictions(self, X):
        started = time.monotonic()
        if self.closed or self.frozen_root is None:
            raise RuntimeError("System model is not available")
        if (
            list(X.columns) != self.columns
            or not 0 < len(X) <= self.data_limits["max_rows"]
        ):
            raise ValueError("Prediction feature schema or row limit")
        directory = self.directory / "predict-inputs" / str(uuid4())
        directory.mkdir(parents=True)
        with (directory / "features.csv").open("x", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow([self.id_column, *self.columns])
            for i, row in enumerate(X.itertuples(index=False, name=None)):
                if (
                    time.monotonic() - started >= self.prediction_timeout
                    or self.bridge.cancelled.is_set()
                ):
                    raise TimeoutError("Prediction preparation deadline/cancellation")
                values = [
                    f"predict:{i}",
                    *[encode_cell(None if pd.isna(v) else v) for v in row],
                ]
                if any(
                    len(v.encode()) > self.data_limits["max_field_bytes"]
                    for v in values
                ):
                    raise ValueError("Prediction field limit")
                writer.writerow(values)
                if stream.tell() > self.data_limits["max_file_bytes"]:
                    raise ValueError("Prediction file limit")
        ref = file_descriptor(directory, "features.csv", self.data_limits)
        ref["path"] = str(directory / ref["path"])
        remaining = self.prediction_timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError("Prediction input preparation exhausted deadline")
        report = self.bridge.call(
            "predict",
            timeout_seconds=remaining,
            run_root=str(self.directory / "predictions"),
            frozen_root=str(self.frozen_root),
            features=ref,
            timeout_ms=math.floor(remaining * 1000),
        )
        self.prediction_records.append(report)
        (directory / "system-prediction.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "elapsed_ms": (time.monotonic() - started) * 1000,
                    "features": ref,
                    "prediction": report,
                }
            )
        )
        if (
            report["status"] != "completed"
            or report["calls"] != {"models": 0, "fits": 0, "predictions": 1}
            or report["frozen_id"] != self.fit_response["frozen_id"]
        ):
            raise RuntimeError(f"System prediction failed: {report['reason']}")
        ref = report["predictions"]
        path = Path(ref["path"]).resolve()
        if (
            not path.is_relative_to(self.directory / "predictions")
            or path.stat().st_size > self.data_limits["max_file_bytes"]
        ):
            raise ValueError("Prediction output path or size")
        limits = {
            **self.data_limits,
            "max_memory_bytes": self.data_limits["max_memory_bytes"] // 2,
        }
        columns, values = read_table(ref, limits)
        rows = [dict(zip(columns, row, strict=True)) for row in values]
        if len(rows) != len(X) or [row[self.id_column] for row in rows] != [
            f"predict:{i}" for i in range(len(X))
        ]:
            raise ValueError("Prediction order mismatch")
        if time.monotonic() - started >= self.prediction_timeout:
            raise TimeoutError("Prediction output validation exceeded deadline")
        return rows

    def _predict(self, X):
        if self.raw_classes:
            return self.predict_from_proba(self._predict_proba(X))
        column = self.protocol["prediction"]["targets"][0]["value_column"]
        return pd.Series(
            [float(row[column]) for row in self._predictions(X)],
            index=X.index,
            name=self.target,
        )

    def _predict_proba(self, X):
        if not self.raw_classes:
            raise ValueError("Regression has no class probabilities")
        columns = self.protocol["prediction"]["targets"][0]["probability_columns"]
        rows = self._predictions(X)
        return pd.DataFrame(
            [[float(row[c]) for c in columns] for row in rows],
            index=X.index,
            columns=self.raw_classes,
        )

    def cancel(self):
        self.bridge.cancel()

    def cleanup(self):
        self.closed = True
        self.bridge.close()
