import json

import pytest
from statigent_benchmarks.prepare import prepare
from test_modeling_dataset_v3 import LIMITS
from test_modeling_prepare_ds import source


def request(tmp_path):
    root, task = source(tmp_path)
    return {
        "version": 1,
        "request_id": "prepare-test",
        "operation": "prepare",
        "task": task,
        "source_root": str(root),
        "dataset_root": str(tmp_path / "prepared"),
        "seed": 17,
        "limits": LIMITS,
    }


def test_create_reuse_identity_and_original_cost(tmp_path):
    config = request(tmp_path)
    created = prepare(config)
    manifest_path = tmp_path / "prepared/dataset.json"
    original = manifest_path.read_bytes()
    reused = prepare({**config, "operation": "reuse"})
    assert created["reused_from"] is None
    assert reused["reused_from"] == config["dataset_root"]
    assert created["dataset"] == reused["dataset"]
    assert reused["original_preparation"] == created["original_preparation"]
    assert created["llm_calls"] == reused["fits"] == reused["downloads"] == 0
    assert reused["elapsed_ms"] >= 0
    with pytest.raises(FileExistsError):
        prepare(config)
    with pytest.raises(ValueError, match="identity mismatch"):
        prepare({**config, "operation": "reuse", "seed": 18})
    assert manifest_path.read_bytes() == original


def test_reuse_verifies_source_and_prepared_hashes(tmp_path):
    config = request(tmp_path)
    prepare(config)
    source_path = tmp_path / "source/task.txt"
    original = source_path.read_bytes()
    source_path.write_text("corrupt source")
    with pytest.raises(ValueError, match="Changed benchmark source"):
        prepare({**config, "operation": "reuse"})
    source_path.write_bytes(original)
    manifest = tmp_path / "prepared/dataset.json"
    value = json.loads(manifest.read_text())
    value["seed"] = 18
    manifest.chmod(0o644)
    manifest.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="manifest hash"):
        prepare({**config, "operation": "reuse"})


def test_original_tree_cannot_be_preparation_destination(tmp_path):
    config = request(tmp_path)
    with pytest.raises(ValueError, match="outside original"):
        prepare({**config, "dataset_root": str(tmp_path / "source/new")})
    assert not (tmp_path / "source/new").exists()
