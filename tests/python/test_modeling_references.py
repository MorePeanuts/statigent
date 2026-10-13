import hashlib
import json
import math
from pathlib import Path
from zipfile import ZipFile, ZipInfo

import pytest
from statigent_benchmarks.ds_catalog import MAPPINGS, MINIMIZE, sha256
from statigent_benchmarks.references import (
    ReferenceError,
    References,
    check_dependencies,
    member_name,
    parse_reference,
    read_references,
)


def make_archive(tmp_path, extra=None, baseline=b"0.5", reference=b"0.9"):
    path = tmp_path / "references.zip"
    contents = {
        member_name("task", "baseline"): baseline,
        member_name("task", "GT"): reference,
    }
    with ZipFile(path, "w") as zipped:
        for name, data in contents.items():
            zipped.writestr(name, data)
        if extra:
            zipped.writestr(*extra)
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}
    return path, sha256(path), hashes


def test_safe_reference_read_and_rpg(tmp_path):
    path, identity, hashes = make_archive(tmp_path)
    refs = read_references(path, identity, "task", "maximize", hashes)
    assert refs.rpg(0.7) == pytest.approx(0.5)
    assert refs.rpg(1.0) > 1
    assert refs.rpg(0.0) == 0
    assert References(10, 2, "minimize").rpg(0) == 1.25
    assert sha256(path) == identity
    assert list(tmp_path.iterdir()) == [path]  # 读取不会解包。


@pytest.mark.parametrize(
    "text",
    [
        b"nan",
        b"inf",
        b"1e999",
        b"1/2",
        b"__import__('os').system('bad')",
        b"",
        b"1" * 257,
    ],
)
def test_reference_numeric_grammar(text):
    with pytest.raises(ReferenceError):
        parse_reference(text)
    assert parse_reference(b" -1.5e-2\n") == -0.015


@pytest.mark.parametrize(
    "name", ["../escape", "/absolute", "a/../escape", "a\\escape", "a//escape"]
)
def test_unsafe_archive_members_rejected_without_extracting(tmp_path, name):
    path, identity, hashes = make_archive(tmp_path, (name, "bad"))
    with pytest.raises(ReferenceError, match="Unsafe"):
        read_references(path, identity, "task", "maximize", hashes)


def test_symlink_duplicate_missing_and_hash_mismatch(tmp_path):
    link = ZipInfo("link")
    link.external_attr = 0o120777 << 16
    path, identity, hashes = make_archive(tmp_path, (link, "target"))
    with pytest.raises(ReferenceError, match="Unsafe"):
        read_references(path, identity, "task", "maximize", hashes)
    with pytest.warns(UserWarning, match="Duplicate"):
        path, identity, hashes = make_archive(
            tmp_path, (member_name("task", "GT"), "0.7")
        )
    with pytest.raises(ReferenceError, match="duplicate"):
        read_references(path, identity, "task", "maximize", hashes)
    path, identity, hashes = make_archive(tmp_path)
    with pytest.raises(ReferenceError, match="Missing"):
        read_references(path, identity, "missing", "maximize", hashes)
    with pytest.raises(ReferenceError, match="not allowed|Invalid"):
        read_references(path, identity, "../task", "maximize", hashes)
    with pytest.raises(ReferenceError, match="hash"):
        read_references(path, "0" * 64, "task", "maximize", hashes)
    hashes[member_name("task", "GT")] = "0" * 64
    with pytest.raises(ReferenceError, match="hash"):
        read_references(path, identity, "task", "maximize", hashes)


@pytest.mark.parametrize(
    "baseline,reference,direction",
    [
        (0, 0, "maximize"),
        (1, 0, "maximize"),
        (0, 1, "minimize"),
        (math.nan, 1, "maximize"),
        (0, math.inf, "maximize"),
        (0, 1, "unknown"),
    ],
)
def test_invalid_rpg_materials(baseline, reference, direction):
    with pytest.raises(ReferenceError):
        References(baseline, reference, direction)


@pytest.mark.upstream
def test_all_pinned_references_and_scripts_are_unchanged():
    root = Path("benchmarks")
    manifest = json.loads(
        Path("src/evaluation/benchmarks/modeling/dsbench-references.json").read_text()
    )
    assert check_dependencies() == manifest["dependencies"]
    path = root / manifest["archive"]["path"]
    identity = sha256(path)
    assert identity == manifest["archive"]["sha256"]
    for task, mapping in MAPPINGS.items():
        read_references(
            path,
            identity,
            task,
            "minimize" if mapping["metric"] in MINIMIZE else "maximize",
            manifest["members"],
        )
    catalog = json.loads((root / "metadata/modeling-task-catalog.json").read_text())
    for task in catalog["tasks"]:
        if task["benchmark"] == "dsbench-modeling":
            script = task["protocol"]["scorer"]
            assert sha256(root / script["path"]) == script["sha256"]
    assert sha256(path) == identity
