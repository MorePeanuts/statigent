"""有界受信进程桥；只控制本次 Bun 进程组，不执行全局容器清理。"""

import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path
from uuid import uuid4


class SystemBridge:
    def __init__(self, repository: Path, root: Path, credential_names=()):
        self.repository = repository.resolve()
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=False)
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.active = None
        self.environment = {
            k: os.environ[k]
            for k in (
                "PATH",
                "HOME",
                "TMPDIR",
                "DOCKER_HOST",
                "DOCKER_CONTEXT",
                "UV_CACHE_DIR",
                "UV_PYTHON_DOWNLOADS",
            )
            if k in os.environ
        }
        for name in credential_names:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                raise ValueError("Invalid credential environment name")
            if name in os.environ:
                self.environment[name] = os.environ[name]

    def cancel(self):
        self.cancelled.set()

    def close(self):
        self.cancel()
        if not self.lock.acquire(timeout=35):
            raise RuntimeError("System cleanup is unconfirmed")
        self.lock.release()

    def _terminate(self):
        if self.active is None or self.active.poll() is not None:
            return False
        self.active.send_signal(signal.SIGTERM)
        try:
            self.active.wait(timeout=30)
            return False
        except subprocess.TimeoutExpired:
            os.killpg(self.active.pid, signal.SIGKILL)
            self.active.wait()
            return True

    def call(self, operation, *, timeout_seconds, **fields):
        if not 0 < timeout_seconds <= 86400:
            raise ValueError("Bridge requires a bounded timeout")
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("System bridge operations must be serialized")
        directory = self.root / str(uuid4())
        directory.mkdir()
        request = {
            "version": 1,
            "request_id": directory.name,
            "operation": operation,
            **fields,
        }
        raw = json.dumps(request, ensure_ascii=False).encode()
        started = time.monotonic()
        forced = False
        failure = None
        try:
            if len(raw) > 1024**2:
                raise ValueError("System bridge request limit")
            if self.cancelled.is_set():
                raise RuntimeError("System bridge cancelled")
            (directory / "request.json").write_bytes(raw)
            with (
                (directory / "request.json").open("rb") as stdin,
                (directory / "stdout.json").open("xb") as stdout,
                (directory / "stderr.txt").open("xb") as stderr,
            ):
                self.active = subprocess.Popen(
                    ["bun", "run", "src/modeling/system-bridge.ts"],
                    cwd=self.repository,
                    env=self.environment,
                    stdin=stdin,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
                while self.active.poll() is None:
                    if self.cancelled.is_set():
                        failure = "cancelled"
                    elif time.monotonic() - started >= timeout_seconds:
                        failure = "timed_out"
                    elif stdout.tell() > 1024**2 or stderr.tell() > 65536:
                        failure = "output_limit"
                    if failure:
                        # 强制终止意味着不能声明容器清理已确认，保留全部记录。
                        forced = self._terminate()
                        break
                    self.cancelled.wait(0.05)
                code = self.active.returncode
            if failure:
                raise RuntimeError(f"System bridge {failure}; forced={forced}")
            if (directory / "stdout.json").stat().st_size > 1024**2 or (
                directory / "stderr.txt"
            ).stat().st_size > 65536:
                raise ValueError("System bridge output limit")
            reply = json.loads((directory / "stdout.json").read_bytes())
            if (
                reply.get("version") != 1
                or reply.get("request_id") != request["request_id"]
                or type(reply.get("ok")) is not bool
            ):
                raise ValueError("System bridge response identity")
            if not reply["ok"] or code != 0:
                raise RuntimeError(f"System bridge failed: {reply.get('error', code)}")
            if set(reply) != {
                "version",
                "request_id",
                "ok",
                "result",
            } or not isinstance(reply["result"], dict):
                raise ValueError("System bridge malformed result")
            return reply["result"]
        except BaseException as error:
            failure = failure or str(error)[:4096]
            forced = self._terminate() or forced
            raise
        finally:
            (directory / "bridge.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "request_id": request["request_id"],
                        "operation": operation,
                        "elapsed_ms": (time.monotonic() - started) * 1000,
                        "failure": failure,
                        "forced_termination": forced,
                    }
                )
            )
            self.active = None
            self.lock.release()
