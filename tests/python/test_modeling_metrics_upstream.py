"""显式调用固定的全部 DSBench 评分脚本；只使用合成数据，不修改上游。"""

import csv
import json
import math
import os
import subprocess
from pathlib import Path

import pytest
from statigent_benchmarks.ds_catalog import MAPPINGS, sha256
from statigent_benchmarks.references import check_dependencies
from statigent_modeling.metrics_v2 import MetricUndefined
from statigent_modeling.protocol_v2 import create_protocol_v2
from statigent_modeling.scoring_v2 import score_v2
from test_modeling_scoring_v2 import request

pytestmark = pytest.mark.upstream
ROOT = Path(__file__).resolve().parents[2]
CATALOG = json.loads(
    (ROOT / "benchmarks/metadata/modeling-task-catalog.json").read_text()
)
TASKS = {
    t["task_id"]: t for t in CATALOG["tasks"] if t["benchmark"] == "dsbench-modeling"
}


def write_csv(path, columns, rows):
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(columns)
        writer.writerows(rows)


def run_upstream(tmp_path, task, actual, predictions):
    source = TASKS[task]["protocol"]["scorer"]
    script = ROOT / "benchmarks" / source["path"]
    assert sha256(script) == source["sha256"]
    mapping = MAPPINGS[task]
    columns = [mapping["id_column"], *mapping["targets"]]
    write_csv(tmp_path / "official-labels.csv", columns, actual)
    write_csv(tmp_path / "official-predictions.csv", columns, predictions)
    output = tmp_path / "official"
    output.mkdir(exist_ok=True)
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "UV_CACHE_DIR")
        if key in os.environ
    }
    result = subprocess.run(
        [
            "uv",
            "run",
            "--offline",
            "--frozen",
            "--no-sync",
            "--project",
            str(ROOT),
            "python",
            str(script),
            "--path",
            str(tmp_path),
            "--name",
            "official",
            "--answer_file",
            str(tmp_path / "official-labels.csv"),
            "--predict_file",
            str(tmp_path / "official-predictions.csv"),
            "--value",
            mapping["targets"][0],
        ],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert sha256(script) == source["sha256"]
    return result, output / "result.txt"


def case(task, tied):
    mapping = MAPPINGS[task]
    kind = mapping["kind"]
    classes = (
        []
        if kind == "regression"
        else ["0", "1"]
        if kind in ("binary", "multilabel")
        else ["3", "5", "8"]
        if kind == "ordinal"
        else ["a", "b", "c", "d"]
    )
    protocol = create_protocol_v2(
        {
            "kind": kind,
            "metric_id": mapping["metric"],
            "id_column": "row_id",
            "feature_columns": ["feature"],
            "targets": [
                {
                    "name": target,
                    "classes": classes,
                    "positive_class": "1" if kind in ("binary", "multilabel") else None,
                    "levels": [3, 5, 8] if kind == "ordinal" else None,
                }
                for target in mapping["targets"]
            ],
        }
    )
    actual, predictions, exported = [], [], []
    for i in range(4):
        identity = f"row-{i}"
        if kind == "regression":
            actual.append([identity, [1, 2, 5, 9][i]])
            value = 0 if tied else [1.5, 1.2, 6, 7][i]
            predictions.append([identity, value])
            exported.append([identity, value])
        elif protocol["output"] in ("probabilities", "multilabel-probabilities"):
            actual.append([identity, *([str(i % 2)] * len(mapping["targets"]))])
            positive = 0.5 if tied else [0.1, 0.9, 0.7, 0.3][i]
            label = "1" if positive > 0.5 else "0"
            predictions.append(
                [identity, *([label, 1 - positive, positive] * len(mapping["targets"]))]
            )
            exported.append([identity, *([positive] * len(mapping["targets"]))])
        elif protocol["output"] == "ranked-labels":
            actual.append([identity, classes[i]])
            candidates = (
                ["a", "b", "c"]
                if tied
                else [["c", "b", "a"], ["a"], ["b", "c", "a"], ["a", "b", "c"]][i]
            )
            predictions.append([identity, json.dumps(candidates)])
            exported.append([identity, " ".join(candidates)])
        else:
            true = classes[[0, 1, 2 if len(classes) > 2 else 0, 1][i]]
            predicted = (
                classes[0]
                if tied
                else classes[
                    [0, 2 if len(classes) > 2 else 0, 2 if len(classes) > 2 else 1, 1][
                        i
                    ]
                ]
            )
            actual.append([identity, true])
            predictions.append([identity, predicted])
            exported.append([identity, predicted])
    return protocol, actual, predictions, exported


@pytest.mark.parametrize("task", list(MAPPINGS))
@pytest.mark.parametrize("tied", [False, True], ids=["ordinary", "ties"])
def test_every_published_script_matches_frozen_definition(tmp_path, task, tied):
    check_dependencies()
    protocol, labels, predictions, exported = case(task, tied)
    local = score_v2(
        request(
            tmp_path,
            protocol,
            labels,
            predictions[::-1],
            "test",
            optional=protocol["output"] != "ranked-labels",
        )
    )
    result, output = run_upstream(tmp_path, task, labels, exported)
    assert result.returncode == 0, result.stderr
    official = float(output.read_text().strip())
    assert math.isfinite(official)
    assert local["value"] == pytest.approx(official, rel=1e-12, abs=1e-12)


def test_published_double_zero_smape_is_reported_as_undefined(tmp_path):
    task = "playground-series-s3e19"
    protocol, _, _, _ = case(task, False)
    labels, predictions = [["row-0", 0], ["row-1", 1]], [["row-0", 0], ["row-1", 1]]
    with pytest.raises(MetricUndefined, match="double zero"):
        score_v2(request(tmp_path, protocol, labels, predictions, "test"))
    result, output = run_upstream(tmp_path, task, labels, predictions)
    assert result.returncode == 0
    assert math.isnan(float(output.read_text().strip()))
