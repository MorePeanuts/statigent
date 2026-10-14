import csv
import json
from pathlib import Path

import pytest
from statigent_benchmarks.ds_catalog import sha256
from statigent_benchmarks.prepare_tab import prepare_tab, read_members
from statigent_benchmarks.tabular_source import decoded_source
from statigent_modeling.data_v3 import decode_cell
from test_modeling_dataset_v3 import LIMITS

pytest.importorskip("arff", reason="Explicit data group: uv sync --group data")
pa = pytest.importorskip("pyarrow", reason="Explicit data group: uv sync --group data")


def test_nominal_declaration_missing_marker_is_not_a_category(tmp_path):
    path = tmp_path / "nominal.arff"
    path.write_text(
        "@RELATION missing\n@ATTRIBUTE token {?, '?', '01'}\n@DATA\n?\n'?'\n'01'\n"
    )
    with decoded_source(path, LIMITS) as (columns, rows):
        assert columns[0]["categories"] == ["?", "01"]
        assert [row["token"] for _, row in rows] == [None, "?", "01"]


def source(tmp_path, format):
    root = tmp_path / "source"
    root.mkdir()
    values = ["?", "NA", "01", "类别", None]
    labels = ["01", "1", "类别"]
    rows = [
        {
            "number": i,
            "nominal": values[i % 5],
            "text": "" if i % 2 else "?",
            "target": labels[i % 3],
        }
        for i in range(60)
    ]
    if format == "arff":
        import arff

        # 用引号包住 '?' 与空字符串，区别于未加引号的缺失标记。
        content = (
            "@RELATION synthetic\n@ATTRIBUTE number INTEGER\n"
            "@ATTRIBUTE nominal {'?','NA','01','类别'}\n@ATTRIBUTE text STRING\n"
            "@ATTRIBUTE target {'01','1','类别'}\n@DATA\n"
        )
        content += "\n".join(
            f"{r['number']},"
            + ("?" if r["nominal"] is None else repr(r["nominal"]))
            + ","
            + repr(r["text"])
            + ","
            + repr(r["target"])
            for r in rows
        )
        (root / "data.arff").write_text(content)
        assert arff is not None
    else:
        import pyarrow.parquet as pq

        schema = pa.schema(
            [
                ("number", pa.int64()),
                ("nominal", pa.dictionary(pa.int8(), pa.string())),
                ("text", pa.string()),
                ("target", pa.dictionary(pa.int8(), pa.string())),
            ]
        )
        pq.write_table(
            pa.Table.from_pylist(rows, schema=schema),
            root / "data.parquet",
            row_group_size=20,
        )
    with (root / "splits-r0-f0.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["type", "rowid", "repeat", "fold"])
        writer.writerows(["TRAIN" if i < 48 else "TEST", i, 0, 0] for i in range(60))
    (root / "dataset.json").write_text(
        json.dumps({"data_set_description": {"id": "123", "version": "9"}})
    )
    (root / "lite-metadata.json").write_text(
        json.dumps(
            {
                "dataset_name": "synthetic",
                "task_id_str": "456",
                "num_instances": "60",
                "target_name": "target",
                "problem_type": "multiclass",
                "eval_metric": "log_loss",
                "num_features": "3",
            }
        )
    )
    task = {
        "benchmark": "tabarena-lite",
        "task_id": "456",
        "openml": {"dataset_id": "123", "version": 9, "repeat": 0, "fold": 0},
        "source_revision": "a" * 40,
        "code_revision": "b" * 40,
        "outer_split": "openml-r0f0",
        "files": [
            {
                "path": p.name,
                "bytes": p.stat().st_size,
                "sha256": sha256(p),
                "access": "raw",
            }
            for p in root.iterdir()
        ],
    }
    return root, task, rows


@pytest.mark.parametrize("format", ["arff", "parquet"])
def test_typed_source_and_fixed_members(tmp_path, format):
    root, task, original = source(tmp_path, format)
    with decoded_source(root / f"data.{format}", LIMITS) as (columns, rows):
        assert list(rows) == list(enumerate(original))
        assert [c["kind"] for c in columns] == [
            "numeric",
            "categorical",
            "string",
            "categorical",
        ]
    hashes = {p.name: sha256(p) for p in root.iterdir()}
    prepared = tmp_path / "prepared"
    manifest = prepare_tab(root, task, prepared, seed=17, limits=LIMITS)
    assert manifest["rows"] == {"training": 48, "prediction": 12}
    assert manifest["protocol"]["targets"][0]["classes"] == ["01", "1", "类别"]
    with (prepared / "search/train.csv").open() as stream:
        rows = list(csv.DictReader(stream))
    assert [decode_cell(row["nominal"]) for row in rows[:5]] == [
        "?",
        "NA",
        "01",
        "类别",
        None,
    ]
    assert rows[1]["text"] == ""
    mappings = [
        json.loads(line)
        for line in (prepared / "evaluator/source-rows.jsonl").read_text().splitlines()
    ]
    assert [m["source_row"] for m in mappings] == list(range(60))
    assert mappings[48]["id"] == "openml:123:48"
    assert {p.name: sha256(p) for p in root.iterdir()} == hashes


@pytest.mark.parametrize(
    "rows",
    [
        [["TRAIN", 0, 0, 0], ["TEST", 0, 0, 0]],
        [["TRAIN", 0, 0, 0], ["TRAIN", 0, 0, 0], ["TEST", 1, 0, 0]],
        [["TRAIN", 0, 0, 0], ["TEST", 2, 0, 0]],
        [["TRAIN", -1, 0, 0], ["TEST", 1, 0, 0]],
        [["TRAIN", 0, 0, 0]],
        [["TRAIN", 0, 1, 0], ["TEST", 1, 1, 0]],
    ],
)
def test_reject_invalid_outer_members(tmp_path, rows):
    path = tmp_path / "split.csv"
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["type", "rowid", "repeat", "fold"])
        writer.writerows(rows)
    with pytest.raises(ValueError):
        read_members(path, 2, LIMITS)


@pytest.mark.upstream
@pytest.mark.parametrize("identity", ["363612", "363621", "363685"])
def test_real_tabarena_preparation(tmp_path, identity):
    root = Path(__file__).resolve().parents[2] / "benchmarks"
    tasks = json.loads((root / "metadata/modeling-task-catalog.json").read_text())[
        "tasks"
    ]
    task = next(
        t
        for t in tasks
        if t["benchmark"] == "tabarena-lite" and t["task_id"] == identity
    )
    manifest = prepare_tab(root, task, tmp_path / "prepared", seed=17, limits=LIMITS)
    assert manifest["rows"]["training"] > manifest["rows"]["prediction"] > 0
