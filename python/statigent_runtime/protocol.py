"""Strict validation of host commands before touching a kernel."""

import json
import math
import re

IDENTIFIER = re.compile(r"[-a-zA-Z0-9_.]{1,128}\Z")
LIMIT_KEYS = {
    "cpus",
    "memory_bytes",
    "pids",
    "workspace_bytes",
    "tmp_bytes",
    "startup_timeout_ms",
    "cell_timeout_ms",
    "task_timeout_ms",
    "interrupt_grace_ms",
    "queue_capacity",
    "max_code_bytes",
    "max_frame_bytes",
    "max_output_bytes",
    "max_artifact_bytes",
    "max_artifacts_bytes",
    "preview_chars",
}


class ProtocolError(ValueError):
    """Invalid untrusted protocol data."""


def positive_int(value: object, field: str, minimum: int = 1) -> int:
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise ProtocolError(f"{field}: invalid integer")
    return value


def identifier(value: object, field: str) -> str:
    if (
        not isinstance(value, str)
        or not IDENTIFIER.fullmatch(value)
        or value in (".", "..")
    ):
        raise ProtocolError(f"{field}: invalid identifier")
    return value


def parse_request(
    raw: bytes,
    max_frame_bytes: int,
    session_id: str | None = None,
    max_code_bytes: int = 128 * 1024,
) -> dict:
    if len(raw) > max_frame_bytes:
        raise ProtocolError("message exceeds max_frame_bytes")
    try:
        request = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProtocolError("invalid JSON") from exc
    if not isinstance(request, dict):
        raise ProtocolError("message must be an object")
    if (
        type(request.get("protocol_version")) is not int
        or request["protocol_version"] != 1
    ):
        raise ProtocolError("unsupported protocol_version")
    identifier(request.get("request_id"), "request_id")
    identifier(request.get("session_id"), "session_id")
    if session_id is not None and request["session_id"] != session_id:
        raise ProtocolError("session identity mismatch")
    kind = request.get("type")
    fields = {"protocol_version", "request_id", "session_id", "type"}
    if kind == "init":
        fields |= {"kernel_epoch", "seed", "limits"}
        positive_int(request.get("kernel_epoch"), "kernel_epoch")
        positive_int(request.get("seed"), "seed", 0)
        if request["seed"] > 2**32 - 1:
            raise ProtocolError("seed: exceeds uint32")
        limits = request.get("limits")
        if not isinstance(limits, dict) or set(limits) != LIMIT_KEYS:
            raise ProtocolError("limits: missing or unknown fields")
        for key, value in limits.items():
            if key == "cpus":
                if (
                    type(value) not in (int, float)
                    or not math.isfinite(value)
                    or value <= 0
                ):
                    raise ProtocolError("cpus: invalid positive number")
            else:
                positive_int(value, key)
        if limits["max_frame_bytes"] < 1024 + limits["max_code_bytes"] * 6:
            raise ProtocolError("max_frame_bytes cannot accommodate escaped code")
    elif kind == "execute":
        fields |= {"cell_id", "kernel_epoch", "execution_seq", "code"}
        identifier(request.get("cell_id"), "cell_id")
        positive_int(request.get("kernel_epoch"), "kernel_epoch")
        positive_int(request.get("execution_seq"), "execution_seq")
        code = request.get("code")
        if not isinstance(code, str) or len(code.encode()) > max_code_bytes:
            raise ProtocolError("code: invalid type or excessive bytes")
    elif kind == "interrupt":
        fields |= {"target_request_id", "reason"}
        identifier(request.get("target_request_id"), "target_request_id")
        if request.get("reason") not in (
            "timed_out",
            "cancelled",
            "output_limit_exceeded",
        ):
            raise ProtocolError("invalid interrupt reason")
    elif kind == "restart":
        fields.add("kernel_epoch")
        positive_int(request.get("kernel_epoch"), "kernel_epoch")
    elif kind not in ("collect", "shutdown"):
        raise ProtocolError("unknown request type")
    if set(request) != fields:
        raise ProtocolError("missing or unknown request fields")
    return request
