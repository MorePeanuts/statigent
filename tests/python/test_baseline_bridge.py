import io
import json
from unittest.mock import patch

import pytest
from statigent_baselines.bridge import Bridge, BridgeError, validate_payload


def client(response):
    value = {
        "protocol_version": 1,
        "run_id": "run",
        "request_id": "id",
        "sequence": 1,
        "type": "response",
        **response,
    }
    writer = io.BytesIO()
    bridge = Bridge("run", io.BytesIO(json.dumps(value).encode() + b"\n"), writer)
    return bridge, writer


@patch("statigent_baselines.bridge.uuid.uuid4")
def test_ordered_roundtrip_and_terminal(mock_uuid):
    mock_uuid.return_value.hex = "id"
    bridge, writer = client({"status": "ok", "result": {"accepted": True}})
    assert bridge.request(
        "submission.finish", submission={"kind": "text", "answer": "3"}
    ) == {"accepted": True}
    assert json.loads(writer.getvalue())["sequence"] == 1
    with pytest.raises(RuntimeError, match="closed"):
        bridge.request("execution.execute", code="x=1")


@patch("statigent_baselines.bridge.uuid.uuid4")
def test_bad_identity_closes_without_retry(mock_uuid):
    mock_uuid.return_value.hex = "different"
    bridge, _ = client({"status": "ok", "result": {}})
    with pytest.raises(ValueError, match="identity"):
        bridge.request("execution.execute", code="x=1")
    assert bridge.closed


@patch("statigent_baselines.bridge.uuid.uuid4")
def test_structured_terminal_error(mock_uuid):
    mock_uuid.return_value.hex = "id"
    bridge, _ = client(
        {"status": "error", "code": "budget", "message": "exhausted", "terminal": True}
    )
    with pytest.raises(BridgeError) as error:
        bridge.request("execution.execute", code="x=1")
    assert error.value.terminal and bridge.closed


@pytest.mark.parametrize(
    "payload",
    [{"path": "../private"}, {"path": "/host"}, {"path": "ok", "root": "/host"}],
)
def test_permission_fields_rejected_before_io(payload):
    writer = io.BytesIO()
    bridge = Bridge("run", io.BytesIO(), writer)
    with pytest.raises(ValueError):
        bridge.request("artifact.read", **payload)
    assert not writer.getvalue()


def test_model_history_preserves_reasoning():
    messages = [{"role": "assistant", "content": None, "reasoning_content": "retained"}]
    validate_payload("model.request", {"stage": "planning", "messages": messages})
    assert messages[0]["reasoning_content"] == "retained"
    with pytest.raises(ValueError):
        validate_payload(
            "model.request",
            {"stage": "planning", "messages": messages, "base_url": "other"},
        )
