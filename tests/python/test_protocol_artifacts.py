import json
import os

import pytest
from statigent_runtime.artifacts import ArtifactError, read_workspace
from statigent_runtime.protocol import ProtocolError, parse_request


def execute(**changes):
    return dict(
        protocol_version=1,
        type="execute",
        request_id="r1",
        session_id="s1",
        cell_id="c1",
        kernel_epoch=1,
        execution_seq=1,
        code="x=1",
        **changes,
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("protocol_version", 2),
        ("protocol_version", True),
        ("code", []),
        ("request_id", "../escape"),
        ("request_id", ".."),
        ("kernel_epoch", True),
        ("execution_seq", 0),
        ("session_id", "other"),
    ],
)
def test_reject_bad_requests(field, value):
    request = execute()
    request[field] = value
    with pytest.raises(ProtocolError):
        parse_request(json.dumps(request).encode(), 4096, "s1")


def test_required_fields_size_and_unknowns():
    request = execute()
    assert parse_request(json.dumps(request).encode(), 4096, "s1") == request
    with pytest.raises(ProtocolError, match="max_frame"):
        parse_request(json.dumps(request).encode(), 16)
    with pytest.raises(ProtocolError, match="code"):
        parse_request(json.dumps(request).encode(), 4096, max_code_bytes=1)
    del request["cell_id"]
    with pytest.raises(ProtocolError):
        parse_request(json.dumps(request).encode(), 4096)


def test_safe_workspace_snapshots(tmp_path):
    (tmp_path / "table.txt").write_text("first")
    (tmp_path / "escape").symlink_to("/etc/passwd")
    (tmp_path / "linked-dir").symlink_to("/tmp", target_is_directory=True)
    os.mkfifo(tmp_path / "fifo")
    (tmp_path / "large").write_bytes(b"x" * 20)
    files = dict(read_workspace(tmp_path, 10))
    assert files["table.txt"] == b"first"
    for key in ("escape", "linked-dir", "fifo", "large"):
        assert isinstance(files[key], ArtifactError)
    (tmp_path / "table.txt").write_text("second")
    assert dict(read_workspace(tmp_path, 10))["table.txt"] == b"second"
    assert files["table.txt"] == b"first"
