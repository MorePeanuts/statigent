import io
import tarfile

import pytest
from statigent_baselines.bundle_extract import extract


def archive(path, members):
    with tarfile.open(path, "w") as target:
        for name, kind, content in members:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.size = len(content) if kind == tarfile.REGTYPE else 0
            item.linkname = "../../outside"
            target.addfile(item, io.BytesIO(content) if item.isfile() else None)


@pytest.mark.parametrize(
    "members",
    [
        [("../outside", tarfile.REGTYPE, b"x")],
        [("/outside", tarfile.REGTYPE, b"x")],
        [("link", tarfile.SYMTYPE, b"")],
        [("link", tarfile.LNKTYPE, b"")],
        [("device", tarfile.CHRTYPE, b"")],
        [("file", tarfile.REGTYPE, b"x"), ("file", tarfile.REGTYPE, b"y")],
        [("a/../../outside", tarfile.REGTYPE, b"x")],
    ],
)
def test_bundle_rejects_unsafe_archive_without_leaving_files(tmp_path, members):
    path = tmp_path / "bundle.tar"
    archive(path, members)
    with pytest.raises(ValueError):
        extract(path, tmp_path / "files", 10, 1024)
    assert not (tmp_path / "files").exists()
    assert not (tmp_path / "outside").exists()


def test_bundle_multifile_limits_are_independent_from_report_limit(tmp_path):
    path = tmp_path / "bundle.tar"
    archive(
        path, [(f"./models/{i}.bin", tarfile.REGTYPE, b"model") for i in range(100)]
    )
    assert extract(path, tmp_path / "files", 100, 500) == {"files": 100, "bytes": 500}
    for files, size in [(99, 500), (100, 499)]:
        with pytest.raises(ValueError):
            extract(path, tmp_path / f"invalid-{files}", files, size)
