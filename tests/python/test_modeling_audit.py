import csv
import json

import pytest
from statigent_benchmarks.audit import audit, check_split, source_path
from statigent_benchmarks.ds_catalog import sha256


def split_file(tmp_path, rows):
    path = tmp_path / "split.csv"
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["type", "rowid", "repeat", "fold"])
        writer.writerows(rows)
    return path


@pytest.mark.parametrize(
    "rows",
    [
        [("TRAIN", 0, 0, 0), ("TEST", 0, 0, 0)],
        [("TRAIN", 0, 0, 0), ("TEST", 2, 0, 0)],
        [("TRAIN", 0, 1, 0), ("TEST", 1, 0, 0)],
        [("TRAIN", 0, 0, 0)],
    ],
)
def test_bad_outer_split_rejected(tmp_path, rows):
    with pytest.raises(ValueError):
        check_split(split_file(tmp_path, rows), 2)


def test_audit_does_not_turn_source_checks_into_training_acceptance(tmp_path):
    directory = tmp_path / "tabarena-lite/raw/1"
    directory.mkdir(parents=True)
    (directory / "dataset.json").write_text(
        json.dumps({"data_set_description": {"id": "2", "version": "3"}})
    )
    (directory / "lite-metadata.json").write_text(
        json.dumps({"task_id_str": "1", "num_instances": "2", "num_features": "1"})
    )
    split_file(directory, [("TRAIN", 0, 0, 0), ("TEST", 1, 0, 0)]).rename(
        directory / "splits-r0-f0.csv"
    )
    files = [
        {
            "path": str(p.relative_to(tmp_path)),
            "sha256": sha256(p),
            "bytes": p.stat().st_size,
            "access": "raw",
        }
        for p in directory.iterdir()
    ]
    task = {
        "benchmark": "tabarena-lite",
        "task_id": "1",
        "source_revision": "data",
        "code_revision": "code",
        "files": files,
        "protocol": None,
        "research": {"status": "review_required", "reasons": ["overlap review"]},
        "adaptation": {"status": "blocked", "reasons": ["not implemented"]},
        "acceptance": {
            key: {"status": "not_run", "evidence": []}
            for key in ["preflight", "deterministic", "live"]
        },
        "issues": [],
        "openml": {"dataset_id": "2", "version": 3, "repeat": 0, "fold": 0},
    }
    result = audit(tmp_path, {"tasks": [task]}, {})
    assert result["llm_calls"] == result["fits"] == result["downloads"] == 0
    assert result["status"] == "complete"
    record = result["tasks"][0]
    assert record["raw_decode"] == "not_run"
    assert record["acceptance"]["live"]["status"] == "not_run"
    for source in files:
        assert sha256(tmp_path / source["path"]) == source["sha256"]
    (directory / "dataset.json").write_text("corrupt")
    result = audit(tmp_path, {"tasks": [task]}, {})
    assert result["status"] == "incomplete"
    assert "dataset.json" in result["tasks"][0]["problems"][0]
    assert result["tasks"][0]["structure_status"] == "not_run"


def test_source_cannot_escape_root(tmp_path):
    with pytest.raises(ValueError, match="unsafe"):
        source_path(tmp_path, "../outside")
