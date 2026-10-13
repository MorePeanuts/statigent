"""逐题人工核对的发布协议，不从变量名、默认参数或题面猜指标。"""

import csv
import hashlib
import json
from pathlib import Path

# task | target(s) | source ID | kind | metric definition | prediction form
# 同一指标可以对应不同上游表达式；逐题源码哈希与差分测试冻结实际行为。
_ROWS = """
titanic|Survived|PassengerId|binary|accuracy-v1|label
santander-customer-transaction-prediction|target|ID_code|binary|roc-auc-v1|probabilities
porto-seguro-safe-driver-prediction|target|id|binary|normalized-gini-ds-v1|probabilities
santander-customer-satisfaction|TARGET|ID|binary|roc-auc-v1|probabilities
santander-value-prediction-challenge|target|ID|regression|rmsle-numpy-log-v1|numeric
playground-series-s4e1|Exited|id|binary|roc-auc-v1|probabilities
playground-series-s4e2|NObeyesdad|id|multiclass|accuracy-v1|label
bike-sharing-demand|count|datetime|regression|rmsle-numpy-log-v1|numeric
playground-series-s4e5|FloodProbability|id|regression|r2-sklearn-v1|numeric
playground-series-s4e4|Rings|id|regression|rmsle-sklearn-v1|numeric
microsoft-malware-prediction|HasDetections|MachineIdentifier|binary|roc-auc-v1|probabilities
spaceship-titanic|Transported|PassengerId|binary|accuracy-v1|label
dont-overfit-ii|target|id|binary|roc-auc-v1|probabilities
playground-series-s4e3|Pastry,Z_Scratch,K_Scatch,Stains,Dirtiness,Bumps,Other_Faults|id|multilabel|mean-target-auc-v1|multilabel-probabilities
tabular-playground-series-sep-2021|claim|id|binary|roc-auc-v1|probabilities
playground-series-s3e24|smoking|id|binary|roc-auc-v1|probabilities
tabular-playground-series-aug-2022|failure|id|binary|roc-auc-v1|probabilities
playground-series-s3e14|yield|id|regression|mae-v1|numeric
instant-gratification|target|id|binary|roc-auc-v1|probabilities
tabular-playground-series-aug-2021|loss|id|regression|rmse-v1|numeric
tabular-playground-series-jan-2021|target|id|regression|rmse-v1|numeric
playground-series-s3e23|defects|id|binary|roc-auc-v1|probabilities
playground-series-s3e25|Hardness|id|regression|median-absolute-error-v1|numeric
playground-series-s3e22|outcome|id|multiclass|micro-f1-v1|label
playground-series-s3e17|Machine failure|id|binary|roc-auc-v1|probabilities
tabular-playground-series-mar-2021|target|id|binary|roc-auc-v1|probabilities
playground-series-s3e20|emission|ID_LAT_LON_YEAR_WEEK|regression|rmse-v1|numeric
tabular-playground-series-feb-2021|target|id|regression|rmse-v1|numeric
playground-series-s3e16|Age|id|regression|mae-v1|numeric
tabular-playground-series-nov-2021|target|id|binary|roc-auc-v1|probabilities
cat-in-the-dat|target|id|binary|roc-auc-v1|probabilities
tabular-playground-series-feb-2022|target|row_id|multiclass|accuracy-v1|label
tabular-playground-series-apr-2021|Survived|PassengerId|binary|accuracy-v1|label
tabular-playground-series-dec-2021|Cover_Type|Id|multiclass|accuracy-v1|label
playground-series-s3e19|num_sold|id|regression|smape-ds-v1|numeric
cat-in-the-dat-ii|target|id|binary|roc-auc-v1|probabilities
tabular-playground-series-may-2022|target|id|binary|roc-auc-v1|probabilities
playground-series-s3e12|target|id|binary|roc-auc-v1|probabilities
playground-series-s3e18|EC1,EC2|id|multilabel|mean-target-auc-v1|multilabel-probabilities
playground-series-s3e11|cost|id|regression|rmsle-sklearn-v1|numeric
playground-series-s3e13|prognosis|id|multiclass|top3-hit-ds-v1|ranked-labels
playground-series-s3e5|quality|Id|ordinal|quadratic-kappa-ds10-v1|label
playground-series-s3e10|Class|id|binary|log-loss-sklearn-inferred-binary-v1|probabilities
playground-series-s3e2|stroke|id|binary|roc-auc-v1|probabilities
playground-series-s3e9|Strength|id|regression|rmse-v1|numeric
playground-series-s3e8|price|id|regression|rmse-v1|numeric
playground-series-s3e6|price|id|regression|rmse-v1|numeric
playground-series-s3e1|MedHouseVal|id|regression|rmse-v1|numeric
playground-series-s3e7|booking_status|id|binary|roc-auc-v1|probabilities
playground-series-s3e3|Attrition|id|binary|roc-auc-v1|probabilities
playground-series-s3e4|Class|id|binary|roc-auc-v1|probabilities
playground-series-s4e6|Target|id|multiclass|accuracy-v1|label
"""
MAPPINGS = {
    row[0]: {
        "targets": row[1].split(","),
        "id_column": row[2],
        "kind": row[3],
        "metric": row[4],
        "prediction_form": row[5],
    }
    for line in _ROWS.strip().splitlines()
    if (row := line.split("|"))
}
MINIMIZE = {
    "rmse-v1",
    "mae-v1",
    "median-absolute-error-v1",
    "rmsle-numpy-log-v1",
    "rmsle-numpy-log1p-v1",
    "rmsle-sklearn-v1",
    "smape-ds-v1",
    "log-loss-sklearn-v1",
    "log-loss-sklearn-inferred-binary-v1",
}
ISSUES = {
    "playground-series-s3e13": [
        "题面的位置权重与代码不符：实际为无位置权重的前三命中；导出按空白拆分，类别含空白须阻塞"
    ],
    "playground-series-s3e19": [
        "题面双零记零，发布 SMAPE 表达式双零产生 NaN；主协议保持未定义并报告评分错误",
        "默认 value 为 Machine failure，实际固定读取 num_sold",
    ],
    "playground-series-s3e20": [
        "smape 变量实际为 RMSE；默认 value 为 Machine failure，实际读取 emission"
    ],
    "playground-series-s3e23": ["rmse 变量实际调用 roc_auc_score，按 AUC 最大化"],
    "playground-series-s3e18": [
        "仅预测 EC1、EC2；EC3–EC6 是训练独有标签，全部排除特征",
        "默认 value 为 Machine failure，实际读取 EC1、EC2",
    ],
    "playground-series-s4e3": [
        "默认 NObeyesdad 及未调用 logloss 函数无效；实际七目标 AUC 等权平均"
    ],
    "playground-series-s3e16": ["默认 yield 无效；显式导出 Age，选择上游优先 Age 分支"],
    "playground-series-s3e10": [
        "上游优先读取 Strength，否则 Class；本地显式导出 Class，使用 fallback 分支"
    ],
    "playground-series-s3e1": ["存在未调用 rmsle 函数；实际为 RMSE"],
    "bike-sharing-demand": [
        "casual、registered 为训练独有标签，必须排除；"
        "datetime 保留为特征，身份采用固定来源行号"
    ],
}


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inspect_csv(path: Path, id_column: str) -> dict:
    """流式检查行宽与原始身份；不返回目标值，不做成绩筛选。"""
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.reader(stream)
        columns = next(reader)
        if not columns or len(set(columns)) != len(columns) or "" in columns:
            raise ValueError(f"Invalid CSV columns: {path}")
        index = columns.index(id_column) if id_column in columns else None
        seen = set()
        valid_id = index is not None
        rows = 0
        for row in reader:
            if len(row) != len(columns):
                raise ValueError(f"Ragged CSV: {path}, row {rows}")
            if index is not None:
                value = row[index]
                valid_id = valid_id and bool(value) and value not in seen
                seen.add(value)
            rows += 1
    if not rows:
        raise ValueError(f"Empty CSV: {path}")
    return {"columns": columns, "rows": rows, "valid_id": valid_id}


def enrich_ds_catalog(root: Path, catalog: dict) -> tuple[dict, list[dict]]:
    tasks = [t for t in catalog["tasks"] if t["benchmark"] == "dsbench-modeling"]
    if {t["task_id"] for t in tasks} != set(MAPPINGS):
        raise ValueError("DSBench candidate/mapping mismatch")
    matrix = []
    for task in tasks:
        name = task["task_id"]
        mapping = MAPPINGS[name]
        directory = root / "dsbench/modeling/public" / name
        train = inspect_csv(directory / "train.csv", mapping["id_column"])
        test = inspect_csv(directory / "test.csv", mapping["id_column"])
        targets = mapping["targets"]
        if not set(targets) <= set(train["columns"]) or set(targets) & set(
            test["columns"]
        ):
            raise ValueError(f"Invalid target columns: {name}")
        excluded = [
            c for c in train["columns"] if c not in test["columns"] and c not in targets
        ]
        # datetime 是可用时间特征，不能因恰好唯一而丢弃其预测信息。
        identity = (
            mapping["id_column"]
            if train["valid_id"] and test["valid_id"] and name != "bike-sharing-demand"
            else None
        )
        features = [c for c in test["columns"] if c != identity]
        if not set(features) <= set(train["columns"]):
            raise ValueError(f"Test-only features: {name}")
        script = root / "dsbench/upstream/data_modeling/evaluation" / f"{name}_eval.py"
        for source in task["files"]:
            if (
                source["access"] != "evaluator"
                and sha256(root / source["path"]) != source["sha256"]
            ):
                raise ValueError(f"Changed public source: {source['path']}")
        task["protocol"] = {
            "kind": mapping["kind"],
            "targets": targets,
            "excluded_columns": excluded,
            "feature_columns": features,
            "identity": {
                "strategy": "source-column" if identity else "source-row",
                "column": identity,
            },
            "metric": {
                "id": mapping["metric"],
                "direction": "minimize"
                if mapping["metric"] in MINIMIZE
                else "maximize",
            },
            "prediction_columns": [mapping["id_column"], *targets],
            "prediction_form": mapping["prediction_form"],
            "scorer": {
                "path": script.relative_to(root).as_posix(),
                "sha256": sha256(script),
                "bytes": script.stat().st_size,
                "access": "evaluator",
            },
        }
        task["issues"] = ISSUES.get(name, []).copy()
        if "sort_values(" in script.read_text():
            task["issues"].append(
                "原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式"
            )
        matrix.append(
            {
                "task_id": name,
                "train_rows": train["rows"],
                "test_rows": test["rows"],
                "feature_count": len(features),
                "protocol": task["protocol"],
                "issues": task["issues"],
            }
        )
    return catalog, matrix


def write_audit_matrix(path: Path, matrix: list[dict], code_revision: str) -> None:
    lines = [
        "# DSBench 建模逐题协议审计",
        "",
        f"上游代码 commit：`{code_revision}`。"
        "逐题脚本与公开输入 SHA-256 见 "
        "[候选目录](../benchmarks/metadata/modeling-task-catalog.json)。",
        "",
        "本表由 `statigent_benchmarks.ds_catalog` 按人工映射和本地发布数据生成；"
        "只读扫描，不训练、不调用模型。指标 ID 绑定实际算法变体，"
        "未完成差分/端到端验收前不代表适配已通过。"
        "身份为固定来源行号的任务另保存导出映射；"
        "不采用上游未赋回排序导致的错行行为。",
        "",
        "| 任务 | 目标 | 指标（方向） | 训练/测试行 | 特征数 | 身份 | 排除 | 偏离 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in matrix:
        p = row["protocol"]
        cells = [
            row["task_id"],
            ", ".join(p["targets"]),
            f"{p['metric']['id']} ({p['metric']['direction']})",
            f"{row['train_rows']}/{row['test_rows']}",
            str(row["feature_count"]),
            p["identity"]["column"] or "source-row",
            ", ".join(p["excluded_columns"]) or "—",
            "；".join(row["issues"]) or "—",
        ]
        lines.append("| " + " | ".join(cells) + " |")
    path.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="显式更新公开候选目录和 DSBench 审计矩阵，不运行评分或训练"
    )
    parser.add_argument("--root", type=Path, default=Path("benchmarks"))
    parser.add_argument("--matrix", type=Path, required=True)
    args = parser.parse_args()
    catalog_path = args.root / "metadata/modeling-task-catalog.json"
    catalog, matrix = enrich_ds_catalog(args.root, json.loads(catalog_path.read_text()))
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    revision = json.loads((args.root / "metadata/ds-tree.json").read_text())["sha"]
    write_audit_matrix(args.matrix, matrix, revision)
    print(json.dumps({"tasks": len(matrix), "llm_calls": 0, "fits": 0}))
