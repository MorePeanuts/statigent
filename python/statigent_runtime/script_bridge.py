"""Docker-only supervisor for protocol v2, without a persistent user interpreter."""

import asyncio
import base64
import ctypes
import importlib.metadata
import json
import mimetypes
import os
import re
import signal
import sys
import tempfile
import time
import uuid
from pathlib import Path

from statigent_runtime.artifacts import ArtifactError, read_workspace
from statigent_runtime.protocol import parse_request as parse_v1


class ProtocolError(ValueError):
    pass


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"[a-zA-Z0-9][-a-zA-Z0-9_.]{0,127}", value
    ):
        raise ProtocolError("invalid identity")


def parse_request(line, limit):
    if len(line) > limit:
        raise ProtocolError("request too large")
    x = json.loads(line)
    if (
        not isinstance(x, dict)
        or x.get("protocol_version") != 2
        or x.get("backend") != "fresh-script"
    ):
        raise ProtocolError("unsupported script protocol/backend")
    for key in ("request_id", "session_id"):
        identifier(x.get(key))
    kind = x.get("type")
    fields = {
        "init": {"seed", "limits"},
        "execute": {"code", "execution_id", "execution_seq"},
        "interrupt": {"target_request_id", "reason"},
        "collect": set(),
        "shutdown": set(),
    }
    if (
        kind not in fields
        or set(x)
        != {"protocol_version", "backend", "request_id", "session_id", "type"}
        | fields[kind]
    ):
        raise ProtocolError("invalid request fields")
    if kind == "init":
        # Reuse the frozen limit validator without changing the v1 wire format.
        parse_v1(
            json.dumps(
                {
                    "protocol_version": 1,
                    "request_id": x["request_id"],
                    "session_id": x["session_id"],
                    "type": "init",
                    "kernel_epoch": 1,
                    "seed": x["seed"],
                    "limits": x["limits"],
                }
            ).encode(),
            limit,
        )
    elif kind == "execute":
        identifier(x["execution_id"])
        if (
            type(x["execution_seq"]) is not int
            or x["execution_seq"] < 1
            or not isinstance(x["code"], str)
        ):
            raise ProtocolError("invalid execution")
    elif kind == "interrupt":
        identifier(x["target_request_id"])
        if x["reason"] not in ("cancelled", "timed_out", "output_limit_exceeded"):
            raise ProtocolError("invalid interrupt")
    return x


def processes():
    result = {}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            stat = (path / "stat").read_text().rsplit(")", 1)[1].split()
            result[int(path.name)] = (stat[0], int(stat[1]))
        except FileNotFoundError:
            continue
    return result


class Bridge:
    def __init__(self):
        if sys.platform != "linux" or not Path("/.dockerenv").exists():
            raise RuntimeError(
                "script supervisor requires isolated Docker PID namespace"
            )
        # Reparent detached grandchildren to us so zombies can be reaped too.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "subreaper initialization failed")
        self.baseline = set(processes())
        self.workspace = Path.cwd()
        self.session = None
        self.limits = None
        self.seed = 0
        self.ids = set()
        self.sequence = 0
        self.active = None
        self.task = None
        self.process = None
        self.reason = None
        self.available = True
        self.output_bytes = 0
        self.artifact_bytes = 0

    def emit(self, request, kind, **data):
        frame = {
            "protocol_version": 2,
            "backend": "fresh-script",
            "session_id": request["session_id"],
            "request_id": request["request_id"],
            "type": kind,
            **data,
        }
        payload = json.dumps(frame) + "\n"
        if self.limits and len(payload.encode()) > self.limits["max_frame_bytes"]:
            raise ProtocolError("outgoing frame exceeds limit")
        sys.stdout.write(payload)
        sys.stdout.flush()

    def identity(self, request):
        return {key: request[key] for key in ("execution_id", "execution_seq")}

    def output(self, request, value):
        self.output_bytes += len(json.dumps(value).encode())
        if self.output_bytes > self.limits["max_output_bytes"]:
            raise ProtocolError("output_limit_exceeded")
        self.emit(request, "output", **self.identity(request), output=value)

    async def stream(self, request, stream, name):
        import codecs

        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while data := await stream.read(1024):
            self.output(
                request,
                {"output_type": "stream", "name": name, "text": decoder.decode(data)},
            )
        tail = decoder.decode(b"", final=True)
        if tail:
            self.output(request, {"output_type": "stream", "name": name, "text": tail})

    def collect(self, request):
        complete = True
        for path, data in read_workspace(
            self.workspace,
            self.limits["max_artifact_bytes"],
            max(1, self.limits["max_artifacts_bytes"] // 128),
        ):
            if isinstance(data, ArtifactError):
                complete = False
                self.emit(
                    request, "diagnostic", message=f"artifact rejected {path}: {data}"
                )
                if "exceeds" in str(data):
                    raise ProtocolError("output_limit_exceeded")
                continue
            self.artifact_bytes += len(data) + len(path.encode()) + 128
            if self.artifact_bytes > self.limits["max_artifacts_bytes"]:
                raise ProtocolError("output_limit_exceeded")
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            if mime not in {
                "image/png",
                "image/jpeg",
                "text/markdown",
                "text/plain",
                "text/csv",
                "text/html",
                "application/json",
                "application/octet-stream",
            }:
                mime = "application/octet-stream"
            self.emit(
                request,
                "artifact",
                **(self.identity(request) if request["type"] == "execute" else {}),
                path=path,
                mime_type=mime,
                data_base64=base64.b64encode(data).decode(),
            )
        return complete

    async def cleanup(self):
        deadline = time.monotonic() + self.limits["interrupt_grace_ms"] / 1000 * 0.7
        # No external helper processes are launched in this namespace. Anything
        # outside the fixed supervisor baseline belongs to the active attempt.
        while True:
            pending = set(processes()) - self.baseline
            for pid in pending:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    continue
            if self.process:
                await asyncio.wait_for(
                    self.process.wait(), max(0.01, deadline - time.monotonic())
                )
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if pid == 0:
                        break
                except ChildProcessError:
                    break
            if not (set(processes()) - self.baseline):
                return
            if time.monotonic() >= deadline:
                raise TimeoutError("descendant cleanup unconfirmed")
            await asyncio.sleep(0.01)

    async def execute(self, request):
        began = time.monotonic()
        timing = {
            "process_startup_ms": None,
            "execution_ms": None,
            "collection_ms": None,
            "cleanup_ms": None,
        }
        started_at = None
        completion = None
        process_identity = None
        complete = True
        status = "error"
        error = None
        readers = []
        channel_transport = None
        fd_read, fd_write = os.pipe()
        try:
            with tempfile.TemporaryDirectory(prefix="statigent-script-") as directory:
                source = Path(directory) / "attempt.py"
                source.write_text(request["code"])
                self.process = await asyncio.create_subprocess_exec(
                    "uv",
                    "run",
                    "--offline",
                    "--no-sync",
                    "--project",
                    "/opt/runtime",
                    "python",
                    "-u",
                    "-m",
                    "statigent_runtime.script_runner",
                    str(source),
                    str(self.seed),
                    str(fd_write),
                    str(self.limits["max_frame_bytes"] - 1024),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    pass_fds=(fd_write,),
                    start_new_session=True,
                    cwd=self.workspace,
                )
                process_identity = {
                    "instance_id": str(uuid.uuid4()),
                    "pid": self.process.pid,
                }
                os.close(fd_write)
                fd_write = -1
                reader = asyncio.StreamReader(limit=self.limits["max_frame_bytes"])
                (
                    channel_transport,
                    _,
                ) = await asyncio.get_running_loop().connect_read_pipe(
                    lambda: asyncio.StreamReaderProtocol(reader),
                    os.fdopen(fd_read, "rb"),
                )
                fd_read = -1

                async def events():
                    nonlocal started_at, completion, error
                    while line := await reader.readline():
                        value = json.loads(line)
                        if not isinstance(value, dict):
                            raise ProtocolError("invalid runner message")
                        kind = value.get("type")
                        if completion is not None:
                            raise ProtocolError("runner output after completion")
                        if kind == "started" and started_at is None:
                            started_at = time.monotonic()
                            timing["process_startup_ms"] = (started_at - began) * 1000
                        elif kind == "display" and started_at is not None:
                            self.output(request, value["output"])
                        elif kind == "complete" and value.get("status") in (
                            "ok",
                            "error",
                        ):
                            completion = value["status"]
                            if started_at is not None:
                                timing["execution_ms"] = (
                                    time.monotonic() - started_at
                                ) * 1000
                            error = value.get("error")
                        else:
                            raise ProtocolError("unexpected runner lifecycle")

                readers = [
                    asyncio.create_task(
                        self.stream(request, self.process.stdout, "stdout")
                    ),
                    asyncio.create_task(
                        self.stream(request, self.process.stderr, "stderr")
                    ),
                    asyncio.create_task(events()),
                ]
                exited = asyncio.create_task(self.process.wait())
                # asyncio.wait() can wait for inherited stdout pipes after the
                # parent exits. Inspect returncode so orphan writers cannot keep
                # the attempt alive until its execution deadline.
                while self.process.returncode is None and not self.reason:
                    finished, _ = await asyncio.wait(
                        [exited, *[r for r in readers if not r.done()]],
                        return_when=asyncio.FIRST_COMPLETED,
                        timeout=0.02,
                    )
                    for item in finished:
                        item.result()
                    if self.reason:
                        break
                cleanup_started = time.monotonic()
                await self.cleanup()
                timing["cleanup_ms"] = (time.monotonic() - cleanup_started) * 1000
                await asyncio.gather(*readers)
                code = await exited
                status = self.reason or (
                    completion
                    if completion == "error" and code == 1
                    else "ok"
                    if completion == "ok" and code == 0 and started_at is not None
                    else "protocol_error"
                )
                if completion is None and self.reason is None:
                    complete = False
                    self.available = False
                if error:
                    self.output(request, {"output_type": "error", **error})
                collection_started = time.monotonic()
                complete = self.collect(request) and complete
                timing["collection_ms"] = (time.monotonic() - collection_started) * 1000
                if not complete and status == "ok":
                    status = "error"
        except BaseException as exc:
            status = self.reason or (
                "output_limit_exceeded" if "limit" in str(exc) else "protocol_error"
            )
            complete = False
            try:
                cleanup_started = time.monotonic()
                await self.cleanup()
                timing["cleanup_ms"] = (time.monotonic() - cleanup_started) * 1000
            except BaseException as cleanup_error:
                self.available = False
                print(f"cleanup failed: {cleanup_error}", file=sys.stderr)
            self.emit(request, "diagnostic", message=str(exc)[:2048])
        finally:
            for task in readers:
                task.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            if channel_transport:
                channel_transport.close()
            for fd in (fd_read, fd_write):
                if fd >= 0:
                    os.close(fd)
            self.process = None
            self.active = None
            self.emit(
                request,
                "result",
                **self.identity(request),
                status=status,
                started=started_at is not None,
                process=process_identity,
                session_available=self.available,
                persistence_complete=complete,
                elapsed_ms=(time.monotonic() - began) * 1000,
                timing=timing,
                **({"error": error} if error else {}),
            )

    async def handle(self, request):
        if request["request_id"] in self.ids:
            raise ProtocolError("duplicate request")
        self.ids.add(request["request_id"])
        kind = request["type"]
        if kind == "init":
            if self.session:
                raise ProtocolError("already initialized")
            self.session, self.seed, self.limits = (
                request["session_id"],
                request["seed"],
                request["limits"],
            )
            versions = {
                key: importlib.metadata.version(key)
                for key in ("numpy", "pandas", "matplotlib", "ipython")
            }
            versions["python"] = sys.version.split()[0]
            self.emit(
                request,
                "ready",
                session_available=True,
                initialization="script-init-v1",
                dependencies=versions,
            )
            return
        if request["session_id"] != self.session or not self.available:
            raise ProtocolError("session unavailable")
        if kind == "execute":
            if (
                self.active
                or request["execution_seq"] != self.sequence + 1
                or len(request["code"].encode()) > self.limits["max_code_bytes"]
            ):
                raise ProtocolError("invalid execution sequence or size")
            self.sequence += 1
            self.active, self.reason = request, None
            self.task = asyncio.create_task(self.execute(request))
        elif kind == "interrupt":
            if (
                self.active
                and request["target_request_id"] == self.active["request_id"]
            ):
                self.reason = self.reason or request["reason"]
                if self.process:
                    try:
                        os.killpg(self.process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            self.emit(
                request,
                "control",
                operation=kind,
                session_available=self.available,
                persistence_complete=True,
                limit_exceeded=False,
            )
        else:
            if self.active:
                raise ProtocolError("control while active")
            complete = True
            exceeded = False
            if kind == "collect":
                try:
                    complete = self.collect(request)
                except ProtocolError:
                    complete, exceeded = False, True
            self.emit(
                request,
                "control",
                operation=kind,
                session_available=kind != "shutdown",
                persistence_complete=complete,
                limit_exceeded=exceeded,
            )


async def main():
    bridge = Bridge()
    reader = asyncio.StreamReader(limit=1024 * 1024)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer
    )
    try:
        while line := await reader.readline():
            request = parse_request(
                line, bridge.limits["max_frame_bytes"] if bridge.limits else 1024 * 1024
            )
            await bridge.handle(request)
            if bridge.limits:
                reader._limit = bridge.limits["max_frame_bytes"]
            if request["type"] == "shutdown":
                break
    finally:
        transport.close()
        if bridge.task:
            bridge.task.cancel()
            await asyncio.gather(bridge.task, return_exceptions=True)
        if bridge.limits:
            await bridge.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
