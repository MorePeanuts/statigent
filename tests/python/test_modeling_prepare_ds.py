import csv
import json
from pathlib import Path

import pytest
from statigent_benchmarks.ds_catalog import MAPPINGS, sha256
from statigent_benchmarks.prepare_ds import export_predictions, prepare_ds
from statigent_modeling.protocol_v2 import prediction_columns_v2
from test_modeling_dataset_v3 import LIMITS


def write_csv(path, columns, rows):
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(columns)
        writer.writerows(rows)


def source(tmp_path, name="titanic", no_id=False):
    root = tmp_path / "source"
    root.mkdir()
    mapping = MAPPINGS[name]
    source_id = mapping["id_column"]
    kind = mapping["kind"]
    classes = (
        ["3", "5", "8"]
        if kind == "ordinal"
        else ["a", "b", "c", "d"]
        if kind == "multiclass"
        else ["0", "1"]
    )
    targets = mapping["targets"]
    id_columns = [] if no_id else [source_id]
    ids = [f"001_{i}_周" for i in range(42)]
    rows = [
        [
            *([ids[i]] if id_columns else []),
            str(i),
            "01",
            *[classes[i % len(classes)]] * len(targets),
            "private-extra",
        ]
        for i in range(40)
    ]
    write_csv(
        root / "train.csv",
        [*id_columns, "value", "code", *targets, "unavailable_label"],
        rows,
    )
    write_csv(
        root / "test.csv",
        [*id_columns, "value", "code"],
        [[*([ids[i]] if id_columns else []), i, "?"] for i in range(40, 42)],
    )
    label_rows = [
        [*([ids[i]] if id_columns else []), *[classes[i % len(classes)]] * len(targets)]
        for i in range(40, 42)
    ]
    write_csv(
        root / "labels.csv",
        [*id_columns, *targets],
        label_rows[::-1] if not no_id else label_rows,
    )
    (root / "task.txt").write_text("Original task says 10,000 test rows. 保留原文。")
    (root / "scorer.py").write_text("# synthetic source, never executed\n")

    def ref(name, access):
        path = root / name
        return {
            "path": name,
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "access": access,
        }

    task = {
        "benchmark": "dsbench-modeling",
        "task_id": name,
        "source_revision": "a" * 40,
        "code_revision": "b" * 40,
        "outer_split": "dsbench-published-train-test",
        "issues": ["synthetic published subset"],
        "files": [
            ref("train.csv", "training"),
            ref("test.csv", "prediction"),
            ref("labels.csv", "evaluator"),
            ref("task.txt", "description"),
        ],
        "protocol": {
            "kind": kind,
            "targets": targets,
            "excluded_columns": ["unavailable_label"],
            "feature_columns": ["value", "code"],
            "identity": {
                "strategy": "source-row" if no_id else "source-column",
                "column": None if no_id else source_id,
            },
            "metric": {"id": mapping["metric"], "direction": "maximize"},
            "prediction_columns": [source_id, *targets],
            "prediction_form": mapping["prediction_form"],
            "scorer": ref("scorer.py", "evaluator"),
        },
    }
    return root, task


@pytest.mark.parametrize("no_id", [False, True])
@pytest.mark.parametrize(
    "name",
    [
        "titanic",
        "playground-series-s3e5",
        "playground-series-s3e13",
        "playground-series-s3e18",
        "playground-series-s4e3",
    ],
)
def test_prepare_and_export_published_order(tmp_path, name, no_id):
    root, task = source(tmp_path, name, no_id)
    hashes = {p.name: sha256(p) for p in root.iterdir()}
    output = tmp_path / "prepared"
    manifest = prepare_ds(root, task, output, seed=17, limits=LIMITS)
    assert manifest["rows"] == {"training": 40, "prediction": 2}
    assert (output / "search/task.txt").read_bytes() == (root / "task.txt").read_bytes()
    assert (
        json.loads((output / "search/adaptation.json").read_text())["published_rows"][
            "prediction"
        ]
        == 2
    )
    assert "unavailable_label" not in (output / "search/train.csv").read_text()
    protocol = manifest["protocol"]
    ids = ["test:0", "test:1"] if no_id else ["test:001_40_周", "test:001_41_周"]
    predictions = []
    for identity in ids[::-1]:
        row = [identity]
        for target in protocol["targets"]:
            if protocol["output"] == "ranked-labels":
                row += [json.dumps(target["classes"][:3])]
            else:
                row += [target["classes"][0]]
                if protocol["output"] == "multilabel-probabilities":
                    row += [0.75, 0.25]
        predictions.append(row)
    write_csv(
        tmp_path / "predictions.csv",
        prediction_columns_v2(protocol, False),
        predictions,
    )
    exported = tmp_path / "export.csv"
    export_predictions(output, tmp_path / "predictions.csv", exported)
    with exported.open() as stream:
        rows = list(csv.reader(stream))
    assert rows[0] == task["protocol"]["prediction_columns"]
    assert [row[0] for row in rows[1:]] == (
        ["0", "1"] if no_id else ["001_40_周", "001_41_周"]
    )
    if protocol["output"] == "ranked-labels":
        assert rows[1][1] == "a b c"
    if protocol["output"] == "multilabel-probabilities":
        assert rows[1][1:] == ["0.25"] * len(protocol["targets"])
    assert {p.name: sha256(p) for p in root.iterdir()} == hashes


def test_changed_source_and_missing_prediction_rejected(tmp_path):
    root, task = source(tmp_path)
    output = tmp_path / "prepared"
    manifest = prepare_ds(root, task, output, seed=17, limits=LIMITS)
    write_csv(
        tmp_path / "bad.csv",
        prediction_columns_v2(manifest["protocol"]),
        [["test:001_40_周", "0"]],
    )
    with pytest.raises(ValueError, match="membership"):
        export_predictions(output, tmp_path / "bad.csv", tmp_path / "export.csv")
    assert not (tmp_path / "export.csv").exists()
    (root / "task.txt").write_text("tamper")
    with pytest.raises(ValueError, match="Changed benchmark source"):
        prepare_ds(root, task, tmp_path / "second", seed=17, limits=LIMITS)


@pytest.mark.upstream
@pytest.mark.parametrize(
    "name",
    [
        "titanic",
        "bike-sharing-demand",
        "playground-series-s3e5",
        "playground-series-s3e13",
        "playground-series-s3e18",
        "playground-series-s4e3",
    ],
)
def test_real_published_preparation(tmp_path, name):
    root = Path(__file__).resolve().parents[2] / "benchmarks"
    tasks = json.loads((root / "metadata/modeling-task-catalog.json").read_text())[
        "tasks"
    ]
    task = next(
        t
        for t in tasks
        if t["benchmark"] == "dsbench-modeling" and t["task_id"] == name
    )
    manifest = prepare_ds(root, task, tmp_path / "prepared", seed=17, limits=LIMITS)
    assert manifest["rows"]["training"] > manifest["rows"]["prediction"] > 0
