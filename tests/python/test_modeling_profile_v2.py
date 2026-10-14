import csv
import json

import pytest
from statigent_modeling.profile_v2 import profile_v2
from statigent_modeling.table_ops import select_table
from test_modeling_dataset_v3 import LIMITS, prepare
from test_modeling_scoring_v2 import file_ref


def test_wide_profile_keeps_all_features_and_only_uses_fit_members(tmp_path):
    features = [
        {
            "name": f"f{i}",
            "kind": "categorical" if i == 0 else "string" if i == 1 else "numeric",
            "source_type": "synthetic",
            "categories": ["01", "1"] if i == 0 else None,
        }
        for i in range(129)
    ]
    rows = [
        (
            f"train:{i}",
            i,
            {
                **{
                    f"f{j}": "01"
                    if j == 0
                    else ""
                    if j == 1
                    else i
                    if i < 16
                    else 99999
                    for j in range(129)
                },
                "EC1": str(i % 2),
                "EC2": str(i % 2),
            },
        )
        for i in range(20)
    ]
    root = tmp_path / "prepared"
    manifest = prepare(
        root, features=features, train=rows, prediction=None, labels=None
    )
    split = json.loads((root / manifest["split"]["file"]["path"]).read_text())
    columns = [
        manifest["protocol"]["id_column"],
        *[f["name"] for f in features],
        "EC1",
        "EC2",
    ]
    selected = select_table(
        {**manifest["training"], "path": str(root / manifest["training"]["path"])},
        tmp_path / "fit.csv",
        columns,
        split["train"],
        LIMITS,
    )
    with (tmp_path / "fit.csv").open() as stream:
        assert len(next(csv.reader(stream))) == 132
    request = {
        "version": 2,
        "request_id": "profile",
        "protocol": manifest["protocol"],
        "input": {k: selected[k] for k in ("path", "bytes", "sha256")},
        "feature_schema": {
            **manifest["feature_schema"],
            "path": str(root / manifest["feature_schema"]["path"]),
        },
        "identity": {
            "train_sha256": manifest["training"]["sha256"],
            "members_sha256": selected["members_sha256"],
            "split_sha256": split["sha256"],
            "protocol_sha256": manifest["protocol"]["protocol_sha256"],
            "feature_schema_sha256": manifest["feature_schema"]["sha256"],
            "snapshot_sha256": selected["sha256"],
        },
        "limits": LIMITS,
    }
    profiles = [
        profile_v2({**request, "request_id": method})
        for method in ("no_eda", "initial_eda", "adaptive_eda", "collaborative")
    ]
    assert all(profile == profiles[0] for profile in profiles)
    profile = profiles[0]
    assert profile["rows"] == 16
    assert (
        profile["column_count"] == 132
        and len(profile["columns"]) == 128
        and profile["omitted_columns"] == 4
    )
    assert profile["targets"] == manifest["protocol"]["targets"]
    assert (
        profile["full_feature_schema"]["sha256"] == manifest["feature_schema"]["sha256"]
    )
    displayed = {column["name"]: column for column in profile["columns"]}
    assert displayed["f0"]["type"] == "categorical"
    assert (
        displayed["f1"]["missing"] == 0
        and displayed["f1"]["categories"][0]["value"] == ""
    )
    assert displayed["f2"]["quantiles"][-1] == 15
    with pytest.raises(ValueError, match="identity mismatch"):
        profile_v2(
            {**request, "identity": {**request["identity"], "members_sha256": "a" * 64}}
        )


def test_file_selection_preserves_order_and_quoted_multiline_values(tmp_path):
    source = file_ref(
        tmp_path,
        "source.csv",
        ["id", "x", "target", "excluded"],
        [
            ["类别\n1", "a,b\nquoted", "01", "never publish"],
            ["b", "?", "1", "never publish"],
        ],
    )
    output = tmp_path / "selected.csv"
    selected = select_table(source, output, ["id", "x"], ["b", "类别\n1"], LIMITS)
    with output.open() as stream:
        assert list(csv.reader(stream)) == [
            ["id", "x"],
            ["b", "?"],
            ["类别\n1", "a,b\nquoted"],
        ]
    assert selected["rows"] == 2
    with pytest.raises(FileExistsError):
        select_table(source, output, ["id", "x"], ["b"], LIMITS)
    with pytest.raises(ValueError, match="Missing selected member"):
        select_table(source, tmp_path / "bad.csv", ["id"], ["missing"], LIMITS)
