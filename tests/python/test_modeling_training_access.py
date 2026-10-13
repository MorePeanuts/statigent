import hashlib
import json

import pytest
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.protocol_v2 import digest
from test_modeling_dataset_v3 import prepare


def test_training_preflight_never_opens_withheld_test_or_evaluator(tmp_path):
    root = tmp_path / "prepared"
    prepare(root)
    before = hashlib.sha256((root / "dataset.json").read_bytes()).hexdigest()
    expected = load_dataset(root)
    (root / "evaluator").rename(tmp_path / "private")
    (root / "final-prediction").rename(tmp_path / "deferred")
    assert load_dataset(root, access="training") == expected
    assert hashlib.sha256((root / "dataset.json").read_bytes()).hexdigest() == before
    with pytest.raises(ValueError, match="non-regular"):
        load_dataset(root)
    with pytest.raises(ValueError, match="access"):
        load_dataset(root, access="anything")
    (root / "dataset.json").chmod(0o644)
    for field in ["prediction", "source_rows"]:
        changed = json.loads(json.dumps(expected))
        ref = (
            changed["prediction"]
            if field == "prediction"
            else changed["evaluator"][field]
        )
        ref["path"] = "../escape.csv"
        changed["dataset_sha256"] = digest(
            {k: v for k, v in changed.items() if k != "dataset_sha256"}
        )
        (root / "dataset.json").write_text(json.dumps(changed))
        with pytest.raises(ValueError, match="reference"):
            load_dataset(root, access="training")
