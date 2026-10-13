import json
import shutil

import pytest
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.execution_seed import prepare_execution_seed
from test_modeling_dataset_v3 import prepare


@pytest.mark.parametrize("explicit", [True, False])
def test_execution_seed_preserves_outer_data_and_is_reproducible(tmp_path, explicit):
    source = tmp_path / "source"
    original = prepare(source, **({} if explicit else {"explicit_split": None}))
    before = {
        p.relative_to(source): p.read_bytes() for p in source.rglob("*") if p.is_file()
    }
    # 派生服务不能依赖外层特征、答案或行映射。
    shutil.rmtree(source / "evaluator")
    shutil.rmtree(source / "final-prediction")
    hashes, splits = [], []
    for index, seed in enumerate([42, 42, 43]):
        output = tmp_path / f"derived-{index}"
        result = prepare_execution_seed(
            dict(
                version=1,
                request_id=str(index),
                source_root=str(source),
                source_sha256=original["dataset_sha256"],
                output_root=str(output),
                seed=seed,
            )
        )
        derived = load_dataset(output, access="training")
        assert derived["seed"] == seed
        for name in [
            "training",
            "prediction",
            "feature_schema",
            "evaluator",
            "public_context",
        ]:
            assert derived[name] == original[name]
        assert not (output / "evaluator").exists()
        assert not (output / "final-prediction").exists()
        assert result["receipt"]["calls"] == {"models": 0, "fits": 0}
        assert result["receipt"]["source_preparation"] == original["preparation"]
        hashes.append(derived["dataset_sha256"])
        splits.append(json.loads((output / "search/split.json").read_text()))
    assert hashes[0] == hashes[1] != hashes[2]
    assert splits[0] == splits[1]
    assert (splits[0]["train"] == splits[2]["train"]) == explicit
    for path in source.rglob("*"):
        if path.is_file():
            assert path.read_bytes() == before[path.relative_to(source)]


def test_invalid_seed_and_source_fail_before_output(tmp_path):
    source = tmp_path / "source"
    manifest = prepare(source)
    request = dict(
        version=1,
        request_id="test",
        source_root=str(source),
        source_sha256=manifest["dataset_sha256"],
        output_root=str(tmp_path / "output"),
        seed=42,
    )
    for patch in [
        {"version": True},
        {"seed": True},
        {"seed": 2**32},
        {"source_sha256": "b" * 64},
    ]:
        with pytest.raises(ValueError):
            prepare_execution_seed({**request, **patch})
        assert not (tmp_path / "output").exists()
