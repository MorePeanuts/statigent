"""Versioned JSONL bridge to one persistent Jupyter kernel.

Only the host owns deadlines and lifecycle authority. The independent stdin loop
can interrupt a running cell; a damaged protocol terminates instead of retrying.
"""

import asyncio
import base64
import importlib.metadata
import json
import mimetypes
import os
import platform
import sys
import time
from pathlib import Path
from queue import Empty

from jupyter_client import AsyncKernelManager
from jupyter_client.channels import AsyncZMQSocketChannel

from statigent_runtime.artifacts import ArtifactError, read_workspace
from statigent_runtime.protocol import ProtocolError, parse_request


class OutputLimit(Exception):
    """Collection has exhausted a configured limit."""


def bounded_channel(max_bytes: int):
    class BoundedChannel(AsyncZMQSocketChannel):
        async def _recv(self, **kwargs):
            # Inspect zero-copy frames before JSON decoding. A single enormous
            # output must not expand into several Python/JSON copies in memory.
            frames = await self.socket.recv_multipart(copy=False)
            if sum(len(frame) for frame in frames) > max_bytes:
                raise OutputLimit("Jupyter message exceeds max_output_bytes")
            _, payload = self.session.feed_identities(
                [bytes(frame) for frame in frames]
            )
            return self.session.deserialize(payload)

    return BoundedChannel


class Bridge:
    def __init__(self, workspace: Path | None = None):
        self.workspace = workspace or Path.cwd()
        self.session_id: str | None = None
        self.epoch = 1
        self.limits: dict = {}
        self.seed = 0
        self.manager: AsyncKernelManager | None = None
        self.client = None
        self.active: asyncio.Task | None = None
        self.active_request: dict | None = None
        self.interrupt_reason: str | None = None
        self.interrupted_at: float | None = None
        self.seen: set[str] = set()
        self.output_bytes = 0
        self.artifact_bytes = 0
        self.last_sequence = 0
        self.available = False
        self.stopping = False

    def emit(self, request: dict, kind: str, **payload) -> None:
        message = {
            "protocol_version": 1,
            "session_id": self.session_id,
            "request_id": request["request_id"],
            "kernel_epoch": self.epoch,
            "type": kind,
            **payload,
        }
        frame = json.dumps(message, ensure_ascii=True, separators=(",", ":")).encode()
        if len(frame) > self.limits.get("max_frame_bytes", 1024 * 1024):
            raise OutputLimit("message exceeds max_frame_bytes")
        sys.stdout.buffer.write(frame + b"\n")
        sys.stdout.buffer.flush()

    def identity(self, request: dict) -> dict:
        return {
            key: request[key] for key in ("cell_id", "kernel_epoch", "execution_seq")
        }

    def diagnostic(self, request: dict, message: str) -> None:
        self.emit(request, "diagnostic", message=message[:512])

    async def start_kernel(self) -> None:
        project = Path(__file__).resolve().parents[2]
        runtime_dir = Path(
            os.environ.get("JUPYTER_RUNTIME_DIR", "/tmp/statigent-jupyter")
        )
        runtime_dir.mkdir(parents=True, exist_ok=True)
        self.manager = AsyncKernelManager(autorestart=False)
        # Even the kernel subprocess is launched through uv; no runtime installs.
        self.manager.kernel_spec.argv = [
            "uv",
            "run",
            "--offline",
            "--no-sync",
            "--project",
            str(project),
            "python",
            "-m",
            "ipykernel_launcher",
            "-f",
            "{connection_file}",
        ]
        self.manager.connection_file = str(
            runtime_dir / f"kernel-{self.session_id}-{self.epoch}.json"
        )
        await self.manager.start_kernel(
            cwd=str(self.workspace), stdout=sys.stderr, stderr=sys.stderr
        )
        self.client = self.manager.client()
        self.client.iopub_channel_class = bounded_channel(
            self.limits["max_output_bytes"]
        )
        self.client.shell_channel_class = bounded_channel(
            self.limits["max_output_bytes"]
        )
        self.client.start_channels()
        await self.client.wait_for_ready(
            timeout=self.limits["startup_timeout_ms"] / 1000
        )
        # Initialization is silent and excluded from user execution counts.
        init_code = (
            "import random, numpy as np\n"
            f"random.seed({self.seed}); np.random.seed({self.seed % 2**32})\n"
            "get_ipython().run_line_magic('matplotlib', 'inline')\n"
        )
        message_id = self.client.execute(
            init_code, silent=True, store_history=False, allow_stdin=False
        )
        deadline = time.monotonic() + self.limits["startup_timeout_ms"] / 1000
        idle = reply = False
        while not (idle and reply):
            if time.monotonic() >= deadline:
                raise TimeoutError("kernel initialization timed out")
            try:
                message = await self.client.get_iopub_msg(timeout=0.05)
                if message.get("parent_header", {}).get("msg_id") == message_id:
                    if message["msg_type"] == "error":
                        raise RuntimeError(str(message["content"]))
                    if (
                        message["msg_type"] == "status"
                        and message["content"]["execution_state"] == "idle"
                    ):
                        idle = True
            except Empty:
                pass
            try:
                message = await self.client.get_shell_msg(timeout=0.01)
                if message.get("parent_header", {}).get("msg_id") == message_id:
                    if message["content"].get("status") != "ok":
                        raise RuntimeError("kernel initialization failed")
                    reply = True
            except Empty:
                pass
        self.available = True

    async def stop_kernel(self) -> None:
        self.available = False
        if self.client is not None:
            self.client.stop_channels()
        if self.manager is not None and self.manager.has_kernel:
            await self.manager.shutdown_kernel(now=True)

    async def interrupt(self, reason: str) -> None:
        if self.active_request is not None and self.interrupt_reason is None:
            self.interrupt_reason = reason
            self.interrupted_at = time.monotonic()
            if self.manager is not None and await self.manager.is_alive():
                await self.manager.interrupt_kernel()

    def output(self, request: dict, content: dict) -> None:
        encoded_size = len(
            json.dumps(content, ensure_ascii=True, separators=(",", ":")).encode()
        )
        if self.output_bytes + encoded_size > self.limits["max_output_bytes"]:
            raise OutputLimit("cumulative output exceeds max_output_bytes")
        self.emit(request, "output", **self.identity(request), output=content)
        self.output_bytes += encoded_size

    def collect_output(self, request: dict, message: dict) -> None:
        kind, data = message["msg_type"], message["content"]
        if kind == "stream":
            # Worst case a Unicode code point takes 12 bytes in escaped JSON.
            chunk_size = max(1, (self.limits["max_frame_bytes"] - 2048) // 12)
            text = data["text"]
            for offset in range(0, len(text), chunk_size):
                self.output(
                    request,
                    {
                        "output_type": "stream",
                        "name": data["name"],
                        "text": text[offset : offset + chunk_size],
                    },
                )
        elif kind in ("display_data", "execute_result", "update_display_data"):
            bundle = {}
            for mime, value in data["data"].items():
                if mime in ("text/plain", "text/html", "image/png"):
                    bundle[mime] = value if isinstance(value, str) else "".join(value)
                else:
                    self.diagnostic(request, f"unsupported MIME ignored: {mime}")
            output = {
                "output_type": kind,
                "data": bundle,
                "metadata": data.get("metadata", {}),
            }
            if kind == "execute_result":
                output["execution_count"] = data["execution_count"]
            if data.get("transient", {}).get("display_id"):
                output["transient"] = {"display_id": data["transient"]["display_id"]}
            self.output(request, output)
        elif kind == "error":
            self.output(
                request,
                {
                    "output_type": "error",
                    **{key: data[key] for key in ("ename", "evalue", "traceback")},
                },
            )
        elif kind == "clear_output":
            self.output(
                request,
                {"output_type": "clear_output", "wait": bool(data.get("wait", False))},
            )

    def collect_files(self, request: dict) -> bool:
        complete = True
        for path, data in read_workspace(
            self.workspace,
            self.limits["max_artifact_bytes"],
            max(1, self.limits["max_artifacts_bytes"] // 128),
        ):
            if isinstance(data, ArtifactError):
                self.diagnostic(request, f"artifact rejected {path}: {data}")
                if "max_artifact_bytes" in str(data) or "max_artifacts_bytes" in str(
                    data
                ):
                    raise OutputLimit(str(data))
                complete = False
                continue
            snapshot_bytes = len(data) + len(path.encode()) + 128
            if (
                self.artifact_bytes + snapshot_bytes
                > self.limits["max_artifacts_bytes"]
            ):
                raise OutputLimit("cumulative artifacts exceed max_artifacts_bytes")
            identity = self.identity(request) if request["type"] == "execute" else {}
            self.emit(
                request,
                "artifact",
                **identity,
                path=path,
                mime_type=mimetypes.guess_type(path)[0] or "application/octet-stream",
                data_base64=base64.b64encode(data).decode(),
            )
            self.artifact_bytes += snapshot_bytes
        return complete

    async def execute(self, request: dict) -> None:
        start = time.monotonic()
        self.active_request = request
        self.interrupt_reason = None
        self.interrupted_at = None
        self.last_sequence = request["execution_seq"]
        complete, idle, reply = True, False, False
        status = "ok"
        error = None
        try:
            message_id = self.client.execute(
                request["code"], allow_stdin=False, stop_on_error=True
            )
            while not (idle and reply):
                if self.manager is None or not await self.manager.is_alive():
                    status, self.available, complete = "kernel_lost", False, False
                    break
                if (
                    self.interrupted_at is not None
                    and time.monotonic() - self.interrupted_at
                    > self.limits["interrupt_grace_ms"] / 1000
                ):
                    status, self.available, complete = "kernel_lost", False, False
                    await self.stop_kernel()
                    break
                try:
                    message = await self.client.get_iopub_msg(timeout=0.025)
                    parent = message.get("parent_header", {}).get("msg_id")
                    if parent != message_id:
                        if message["msg_type"] not in ("status", "execute_input"):
                            self.diagnostic(
                                request,
                                f"late or unknown output omitted; parent={parent}",
                            )
                    elif (
                        message["msg_type"] == "status"
                        and message["content"]["execution_state"] == "idle"
                    ):
                        idle = True
                    elif self.interrupt_reason != "output_limit_exceeded":
                        try:
                            self.collect_output(request, message)
                        except OutputLimit as exc:
                            complete = False
                            self.diagnostic(request, str(exc))
                            await self.interrupt("output_limit_exceeded")
                except Empty:
                    pass
                except OutputLimit as exc:
                    complete = False
                    self.diagnostic(request, str(exc))
                    await self.interrupt("output_limit_exceeded")
                try:
                    message = await self.client.get_shell_msg(timeout=0)
                    if (
                        message.get("parent_header", {}).get("msg_id") == message_id
                        and message["msg_type"] == "execute_reply"
                    ):
                        reply = True
                        content = message["content"]
                        if content.get("status") != "ok":
                            status = "error"
                            error = {
                                key: content.get(key, [] if key == "traceback" else "")
                                for key in ("ename", "evalue", "traceback")
                            }
                except Empty:
                    pass
                except OutputLimit as exc:
                    complete = False
                    self.diagnostic(request, str(exc))
                    self.interrupt_reason = "output_limit_exceeded"
                    await self.stop_kernel()
                    break
            if self.available:
                try:
                    complete = self.collect_files(request) and complete
                except OutputLimit as exc:
                    complete = False
                    self.diagnostic(request, str(exc))
                    self.interrupt_reason = "output_limit_exceeded"
            if self.interrupt_reason is not None:
                status = self.interrupt_reason
            if not self.available:
                complete = False
            # Error diagnostics can also contain enormous user strings. The output
            # event already preserves them subject to its limit; bound result metadata.
            if error:
                error = {
                    "ename": str(error["ename"])[:128],
                    "evalue": str(error["evalue"])[:512],
                    "traceback": [str(line)[:512] for line in error["traceback"][:4]],
                }
            self.emit(
                request,
                "result",
                **self.identity(request),
                status=status,
                kernel_available=self.available,
                elapsed_ms=(time.monotonic() - start) * 1000,
                persistence_complete=complete,
                **({"error": error} if error else {}),
            )
        except Exception as exc:
            self.available = False
            self.diagnostic(
                request, f"bridge execution failed: {type(exc).__name__}: {exc}"
            )
            self.emit(
                request,
                "result",
                **self.identity(request),
                status="kernel_lost",
                kernel_available=False,
                elapsed_ms=(time.monotonic() - start) * 1000,
                persistence_complete=False,
            )
        finally:
            self.active_request = None

    async def settle(self) -> None:
        if self.active is not None and not self.active.done():
            await self.interrupt("cancelled")
            try:
                await asyncio.wait_for(
                    asyncio.shield(self.active),
                    self.limits["interrupt_grace_ms"] / 1000 + 1,
                )
            except TimeoutError:
                await self.stop_kernel()
                self.active.cancel()
                await asyncio.gather(self.active, return_exceptions=True)

    async def dispatch(self, request: dict) -> None:
        kind = request["type"]
        if request["request_id"] in self.seen:
            raise ProtocolError("duplicate request_id")
        self.seen.add(request["request_id"])
        if self.session_id is None:
            if kind != "init":
                raise ProtocolError("first request must initialize the bridge")
            self.session_id = request["session_id"]
            self.epoch, self.seed, self.limits = (
                request["kernel_epoch"],
                request["seed"],
                request["limits"],
            )
            await self.start_kernel()
            versions = {
                name: importlib.metadata.version(name)
                for name in (
                    "ipykernel",
                    "jupyter_client",
                    "nbformat",
                    "numpy",
                    "pandas",
                    "matplotlib",
                    "scikit-learn",
                    "scipy",
                    "joblib",
                )
            }
            versions["python"] = platform.python_version()
            self.emit(request, "ready", kernel_available=True, dependencies=versions)
        elif kind == "execute":
            if not self.available or (
                self.active is not None and not self.active.done()
            ):
                raise ProtocolError("kernel unavailable or execution already active")
            if (
                request["kernel_epoch"] != self.epoch
                or request["execution_seq"] <= self.last_sequence
            ):
                raise ProtocolError("kernel identity or execution sequence mismatch")
            self.active = asyncio.create_task(self.execute(request))
        elif kind == "interrupt":
            if (
                self.active_request is not None
                and self.active_request["request_id"] == request["target_request_id"]
            ):
                await self.interrupt(request["reason"])
            self.emit(
                request, "control", operation=kind, kernel_available=self.available
            )
        elif kind == "restart":
            if request["kernel_epoch"] <= self.epoch:
                raise ProtocolError("restart must advance kernel_epoch")
            await self.settle()
            await self.stop_kernel()
            self.epoch = request["kernel_epoch"]
            await self.start_kernel()
            self.emit(
                request,
                "control",
                operation=kind,
                kernel_available=True,
                files_preserved=True,
            )
        elif kind == "collect":
            if self.active is not None and not self.active.done():
                raise ProtocolError("cannot collect files during execution")
            complete, exceeded = True, False
            try:
                complete = self.collect_files(request)
            except OutputLimit as exc:
                complete, exceeded = False, True
                self.diagnostic(request, str(exc))
            self.emit(
                request,
                "control",
                operation=kind,
                kernel_available=self.available,
                persistence_complete=complete,
                limit_exceeded=exceeded,
            )
        elif kind == "shutdown":
            await self.settle()
            # The host explicitly collects before shutdown. Re-collecting would
            # duplicate snapshots and consume the artifact budget a second time.
            await self.stop_kernel()
            self.emit(
                request,
                "control",
                operation=kind,
                kernel_available=False,
            )
            self.stopping = True
        else:
            raise ProtocolError("bridge already initialized")

    async def run(self) -> None:
        try:
            while not self.stopping:
                limit = self.limits.get("max_frame_bytes", 1024 * 1024)
                raw = await asyncio.to_thread(sys.stdin.buffer.readline, limit + 2)
                if not raw:
                    break
                request = parse_request(
                    raw.rstrip(b"\n"),
                    limit,
                    self.session_id,
                    self.limits.get("max_code_bytes", 128 * 1024),
                )
                await self.dispatch(request)
        finally:
            await self.settle()
            await self.stop_kernel()


def main() -> int:
    try:
        asyncio.run(Bridge().run())
    except Exception as exc:
        print(f"bridge failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
