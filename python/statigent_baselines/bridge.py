"""有界同步 JSONL 客户端；worker 不持有模型凭据或执行生成代码。"""

import json
import re
import sys
import uuid

MAX_REQUEST = 256 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_LOG = 16 * 1024 * 1024
ID = re.compile(r"[a-zA-Z0-9_-]{1,128}\Z")
FIELDS = {
    "model.request": {"stage", "messages"},
    "execution.execute": {"code"},
    "artifact.read": {"path"},
    "bundle.register": {"bundle", "entrypoint"},
    "submission.finish": {"submission"},
}


def relative_path(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError("Invalid artifact path")
    if (
        "\\" in value
        or "\0" in value
        or any(p in ("", ".", "..") for p in value.split("/"))
    ):
        raise ValueError("Expected safe relative artifact path")
    return value


def object_fields(value, fields):
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("Unexpected protocol fields")


def validate_payload(kind, payload):
    if kind not in FIELDS:
        raise ValueError("Unsupported bridge request")
    object_fields(payload, FIELDS[kind])
    if kind == "execution.execute":
        if not isinstance(payload["code"], str) or not payload["code"]:
            raise ValueError("Code must be nonempty text")
    elif kind == "artifact.read":
        relative_path(payload["path"])
    elif kind == "bundle.register":
        relative_path(payload["bundle"])
        relative_path(payload["entrypoint"])
    elif kind == "submission.finish":
        submission = payload["submission"]
        if not isinstance(submission, dict):
            raise ValueError("Invalid final submission")
        form = submission.get("kind")
        if form == "text":
            object_fields(submission, {"kind", "answer"})
            if not isinstance(submission["answer"], str) or not submission["answer"]:
                raise ValueError("Explicit final answer required")
        elif form == "report":
            object_fields(submission, {"kind", "path"})
            relative_path(submission["path"])
        elif form == "predictions":
            object_fields(submission, {"kind", "bundle", "entrypoint"})
            relative_path(submission["bundle"])
            relative_path(submission["entrypoint"])
        else:
            raise ValueError("Unknown output kind")
    elif kind == "model.request":
        stage, messages = payload["stage"], payload["messages"]
        if not isinstance(stage, str) or not ID.fullmatch(stage):
            raise ValueError("Invalid model stage")
        if not isinstance(messages, list) or not 1 <= len(messages) <= 1000:
            raise ValueError("Invalid model history")
        for message in messages:
            if not isinstance(message, dict):
                raise ValueError("Invalid message")
            role = message.get("role")
            allowed = {"role", "content"}
            if role == "assistant":
                allowed |= {"reasoning_content", "tool_calls"}
            elif role == "tool":
                allowed.add("tool_call_id")
            elif role not in ("system", "user"):
                raise ValueError("Unknown message role")
            if set(message) - allowed or not {"role", "content"} <= set(message):
                raise ValueError("Unknown/missing message fields")
            content = message["content"]
            if not isinstance(content, str) and not (
                role == "assistant" and content is None
            ):
                raise ValueError("Expected text model history")
            if "reasoning_content" in message and not isinstance(
                message["reasoning_content"], str
            ):
                raise ValueError("Invalid reasoning history")
            if role == "tool" and not ID.fullmatch(message.get("tool_call_id", "")):
                raise ValueError("Invalid tool identity")
            if "tool_calls" in message:
                calls = message["tool_calls"]
                if not isinstance(calls, list) or len(calls) > 32:
                    raise ValueError("Invalid tool calls")
                for call in calls:
                    object_fields(call, {"id", "type", "function"})
                    object_fields(call["function"], {"name", "arguments"})
                    if (
                        call["type"] != "function"
                        or not all(
                            isinstance(value, str) and ID.fullmatch(value)
                            for value in (call["id"], call["function"]["name"])
                        )
                        or not isinstance(call["function"]["arguments"], str)
                    ):
                        raise ValueError("Invalid tool call")


class BridgeError(RuntimeError):
    def __init__(self, code, message, terminal):
        super().__init__(message)
        self.code = code
        self.terminal = terminal


class Bridge:
    def __init__(self, run_id, reader=None, writer=None):
        if not isinstance(run_id, str) or not ID.fullmatch(run_id):
            raise ValueError("Invalid run identity")
        self.run_id = run_id
        self.reader = reader if reader is not None else sys.stdin.buffer
        self.writer = writer if writer is not None else sys.stdout.buffer
        self.sequence = 0
        self.bytes = 0
        self.closed = False
        self.busy = False

    def request(self, kind, **payload):
        if self.closed or self.busy:
            raise RuntimeError("Bridge closed or request in flight")
        validate_payload(kind, payload)
        self.busy = True
        self.sequence += 1
        identity = {
            "protocol_version": 1,
            "run_id": self.run_id,
            "request_id": uuid.uuid4().hex,
            "sequence": self.sequence,
        }
        try:
            line = json.dumps(
                {**identity, "type": kind, **payload},
                ensure_ascii=False,
                allow_nan=False,
            ).encode()
            self.bytes += len(line)
            if len(line) > MAX_REQUEST or self.bytes > MAX_LOG:
                raise ValueError("Bridge request/log limit exceeded")
            self.writer.write(line + b"\n")
            self.writer.flush()
            response = self.reader.readline(MAX_RESPONSE + 2)
            self.bytes += len(response)
            if not response.endswith(b"\n") or len(response) > MAX_RESPONSE + 1:
                raise ValueError("Incomplete/oversized bridge response")
            if self.bytes > MAX_LOG:
                raise ValueError("Bridge log limit exceeded")
            value = json.loads(response)
            if not isinstance(value, dict) or any(
                value.get(key) != expected or type(value.get(key)) is not type(expected)
                for key, expected in identity.items()
            ):
                raise ValueError("Bridge response identity mismatch")
            if value.get("type") != "response":
                raise ValueError("Unexpected response type")
            if value.get("status") == "ok":
                object_fields(value, {*identity, "type", "status", "result"})
                if not isinstance(value["result"], dict):
                    raise ValueError("Invalid bridge result")
                if kind == "submission.finish":
                    self.closed = True
                return value["result"]
            object_fields(
                value, {*identity, "type", "status", "code", "message", "terminal"}
            )
            if (
                value["status"] != "error"
                or not isinstance(value["code"], str)
                or not ID.fullmatch(value["code"])
                or not isinstance(value["message"], str)
                or type(value["terminal"]) is not bool
            ):
                raise ValueError("Invalid bridge error")
            self.closed = value["terminal"]
            raise BridgeError(value["code"], value["message"], value["terminal"])
        except BridgeError:
            raise
        except BaseException:
            self.closed = True
            raise
        finally:
            self.busy = False
