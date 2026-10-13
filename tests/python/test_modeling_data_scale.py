import csv
import json
import os
import resource
import sys
import time

import pytest
from statigent_benchmarks.ds_catalog import sha256
from statigent_modeling.data_v3 import prepare_rows
from statigent_modeling.dataset_v3 import load_dataset
from statigent_modeling.limits import DEFAULT_DATA_LIMITS
from statigent_modeling.protocol_v2 import prediction_columns_v2
from statigent_modeling.scoring_v2 import score_v2

pytestmark = pytest.mark.scale


def test_large_files_follow_explicit_limits_across_all_data_stages(tmp_path):
    count = 35000
    limits = {
        **DEFAULT_DATA_LIMITS,
        "max_file_bytes": 64 * 1024 * 1024,
        "max_memory_bytes": 1024 * 1024 * 1024,
    }
    feature = "long-realistic-text-field:" + "x" * 1000
    label = "1." + "0" * 1000
    started = time.monotonic()
    root = tmp_path / "prepared"
    manifest = prepare_rows(
        root,
        kind="regression",
        metric_id="mae-v1",
        id_column="id",
        targets=[{"name": "y", "classes": [], "positive_class": None, "levels": None}],
        features=[
            {
                "name": "text",
                "kind": "string",
                "source_type": "synthetic",
                "categories": None,
            }
        ],
        excluded_columns=[],
        train=((f"train:{i}", i, {"text": feature, "y": 1}) for i in range(count)),
        prediction=((f"test:{i}", i, {"text": feature}) for i in range(count)),
        labels=((f"test:{i}", [label]) for i in range(count)),
        seed=17,
        limits=limits,
        provenance={"benchmark": "synthetic-scale"},
    )
    prepared_at = time.monotonic()
    assert load_dataset(root) == manifest
    loaded_at = time.monotonic()
    for ref in [
        manifest["training"],
        manifest["prediction"],
        manifest["evaluator"]["labels"],
    ]:
        assert ref["bytes"] > 32 * 1024 * 1024
    with pytest.raises(ValueError, match="limit"):
        load_dataset(root, DEFAULT_DATA_LIMITS)
    predictions = tmp_path / "predictions.csv"
    with predictions.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(prediction_columns_v2(manifest["protocol"]))
        writer.writerows(
            [f"test:{i}", "2." + "0" * 1000] for i in reversed(range(count))
        )
    assert predictions.stat().st_size > 32 * 1024 * 1024
    request = {
        "version": 2,
        "request_id": "scale",
        "protocol": manifest["protocol"],
        "evaluation_id": "a" * 64,
        "partition": "test",
        "labels": {
            **manifest["evaluator"]["labels"],
            "path": str((root / manifest["evaluator"]["labels"]["path"]).resolve()),
        },
        "predictions": {
            "path": str(predictions.resolve()),
            "bytes": predictions.stat().st_size,
            "sha256": sha256(predictions),
        },
        "limits": limits,
    }
    result = score_v2(request)
    assert result["value"] == 1
    with pytest.raises(ValueError, match="limit"):
        score_v2({**request, "limits": DEFAULT_DATA_LIMITS})
    finished = time.monotonic()
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (
        1 if sys.platform == "darwin" else 1024
    )
    assert rss < limits["max_memory_bytes"]
    report = {
        "status": "passed",
        "rows_per_partition": count,
        "limits": limits,
        "bytes": {
            "training": manifest["training"]["bytes"],
            "prediction_features": manifest["prediction"]["bytes"],
            "labels": manifest["evaluator"]["labels"]["bytes"],
            "predictions": predictions.stat().st_size,
        },
        "prepare_seconds": prepared_at - started,
        "load_seconds": loaded_at - prepared_at,
        "scoring_and_limit_checks_seconds": finished - loaded_at,
        "elapsed_seconds": finished - started,
        "peak_process_rss_bytes": rss,
        "score": result["value"],
        "llm_calls": 0,
        "fits": 0,
    }
    print(json.dumps(report))
    if path := os.environ.get("STATIGENT_SCALE_REPORT"):
        with open(path, "x") as stream:
            json.dump(report, stream, indent=2)
