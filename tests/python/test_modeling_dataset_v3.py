import csv
import json
from pathlib import Path

import pytest
from statigent_modeling.data_v3 import (
    ESCAPE_PREFIX,
    MISSING_TOKEN,
    decode_cell,
    encode_cell,
    prepare_rows,
    split_rows,
)
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.protocol_v2 import create_protocol_v2, digest

LIMITS = {
    "max_file_bytes": 32 * 1024 * 1024,
    "max_rows": 1000000,
    "max_columns": 4096,
    "max_field_bytes": 65536,
    "max_memory_bytes": 512 * 1024 * 1024,
}


def prepare(root, **overrides):
    options = dict(
        kind="multilabel",
        metric_id="mean-target-auc-v1",
        id_column="sample_id",
        targets=[
            {"name": name, "classes": None, "positive_class": "1", "levels": None}
            for name in ["EC1", "EC2"]
        ],
        features=[
            {
                "name": "signal",
                "kind": "numeric",
                "source_type": "CSV",
                "categories": None,
            },
            {
                "name": "token",
                "kind": "categorical",
                "source_type": "CSV",
                "categories": None,
            },
        ],
        excluded_columns=["EC3", "EC4", "EC5", "EC6"],
        train=[
            (
                f"train:{i}",
                i,
                {
                    "signal": i / 3,
                    "token": "01" if i % 2 else None,
                    "EC1": str(i % 2),
                    "EC2": str(i % 2),
                    "EC3": "secret",
                },
            )
            for i in range(20)
        ],
        prediction=[
            ("test:0", 0, {"signal": 10, "token": "?", "EC1": "must not publish"})
        ],
        labels=[("test:0", ["1", "0"])],
        seed=17,
        limits=LIMITS,
        provenance={"benchmark": "synthetic", "source_sha256": "a" * 64},
        explicit_split={
            "train": [f"train:{i}" for i in range(16)],
            "validation": [f"train:{i}" for i in range(16, 20)],
        },
    )
    options.update(overrides)
    return prepare_rows(root, **options)


def rewrite(root, edit):
    path = root / "dataset.json"
    manifest = json.loads(path.read_text())
    edit(manifest)
    manifest["dataset_sha256"] = digest(
        {k: v for k, v in manifest.items() if k != "dataset_sha256"}
    )
    path.chmod(0o644)
    path.write_text(json.dumps(manifest))


def test_partitioned_multi_target_preparation(tmp_path):
    root = tmp_path / "prepared"
    manifest = prepare(root)
    assert load_dataset(root) == manifest
    assert manifest["protocol"]["feature_columns"] == ["signal", "token"]
    assert [t["name"] for t in manifest["protocol"]["targets"]] == ["EC1", "EC2"]
    with (root / manifest["prediction"]["path"]).open() as stream:
        rows = list(csv.reader(stream))
    assert rows == [["sample_id", "signal", "token"], ["test:0", "10", "?"]]
    assert "secret" not in (root / "search/train.csv").read_text()
    mappings = [
        json.loads(line)
        for line in (root / "evaluator/source-rows.jsonl").read_text().splitlines()
    ]
    assert mappings[-1] == {
        "id": "test:0",
        "partition": "prediction",
        "source_row": 0,
        "export_id": None,
    }
    assert manifest["preparation"]["elapsed_ms"] >= 0
    with pytest.raises(FileExistsError):
        prepare(root)
    assert load_dataset(root) == manifest


@pytest.mark.parametrize(
    "value",
    [None, "", "?", "NA", "01", "1", "类别", MISSING_TOKEN, ESCAPE_PREFIX + "x"],
)
def test_lossless_missing_codec(value):
    assert decode_cell(encode_cell(value)) == value


@pytest.mark.parametrize(
    "reference",
    [
        "../labels.csv",
        "/tmp/labels.csv",
        "evaluator/labels.csv",
        "search/../search/train.csv",
    ],
)
def test_refuse_escaping_or_wrong_phase_reference(tmp_path, reference):
    root = tmp_path / "prepared"
    prepare(root)
    rewrite(root, lambda m: m["training"].update(path=reference))
    with pytest.raises(ValueError, match="partition file reference"):
        load_dataset(root)


def test_refuse_tampered_manifest_and_file(tmp_path):
    root = tmp_path / "prepared"
    prepare(root)
    path = root / "dataset.json"
    path.chmod(0o644)
    original = path.read_text()
    path.write_text(original.replace('"seed":17', '"seed":18'))
    with pytest.raises(ValueError, match="manifest hash"):
        load_dataset(root)
    path.write_text(original)
    training = root / "search/train.csv"
    training.chmod(0o644)
    training.write_bytes(training.read_bytes().replace(b"01", b"02"))
    with pytest.raises(ValueError, match="file hash"):
        load_dataset(root)


def test_refuse_symlink_even_if_content_matches(tmp_path):
    root = tmp_path / "prepared"
    prepare(root)
    training = root / "search/train.csv"
    outside = tmp_path / "copy.csv"
    outside.write_bytes(training.read_bytes())
    training.unlink()
    training.symlink_to(outside)
    with pytest.raises(ValueError, match="Escaping"):
        load_dataset(root)


def test_reject_target_as_feature_and_private_class_inference(tmp_path):
    with pytest.raises(ValueError, match="leakage"):
        prepare(
            tmp_path / "leak",
            features=[
                {
                    "name": "EC1",
                    "kind": "string",
                    "categories": None,
                    "source_type": "CSV",
                }
            ],
        )
    with pytest.raises(ValueError, match="Unknown private class"):
        prepare(tmp_path / "private", labels=[("test:0", ["new class", "0"])])
    assert (
        json.loads((tmp_path / "private/failure.json").read_text())["status"]
        == "failed"
    )


def test_fit_only_manifest_and_explicit_limits(tmp_path):
    root = tmp_path / "fit"
    manifest = prepare(root, prediction=None, labels=None)
    assert load_dataset(root) == manifest
    assert manifest["prediction"] is None and manifest["evaluator"]["labels"] is None
    with pytest.raises(ValueError, match="limit exceeded"):
        load_dataset(root, {**LIMITS, "max_file_bytes": 100})


def test_internal_split_tamper_and_mapping_tamper(tmp_path):
    root = tmp_path / "prepared"
    prepare(root)
    rewrite(root, lambda m: m["split"].update(train_rows=15))
    with pytest.raises(ValueError, match="Frozen split"):
        load_dataset(root)
    root2 = tmp_path / "bad-map"
    with pytest.raises(ValueError, match="source identity"):
        prepare(
            root2,
            prediction=[
                ("test:0", 0, {"signal": 1, "token": "?"}),
                ("test:1", 0, {"signal": 2, "token": "?"}),
            ],
        )


def test_shared_ts_python_fixed_split_members():
    cases = json.loads(
        (
            Path(__file__).resolve().parents[1] / "fixtures/modeling-splits-v2.json"
        ).read_text()
    )
    for case in cases:
        protocol = create_protocol_v2(case["input"])
        for rows in (case["labels"]["rows"], case["labels"]["rows"][::-1]):
            values = {
                target["name"]: [row[index + 1] for row in rows]
                for index, target in enumerate(protocol["targets"])
            }
            actual = split_rows([r[0] for r in rows], values, protocol, case["seed"])
            assert {
                key: actual[key] for key in ("train", "validation", "sha256")
            } == case["expected"]
