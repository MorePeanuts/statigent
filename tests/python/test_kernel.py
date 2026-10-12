"""Explicit real-kernel tests; these are not part of the default quick checks."""

import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration
ROOT = Path(__file__).resolve().parents[2]
LIMITS = {
    "cpus": 1,
    "memory_bytes": 1024**3,
    "pids": 128,
    "workspace_bytes": 64 * 1024**2,
    "tmp_bytes": 32 * 1024**2,
    "startup_timeout_ms": 30000,
    "cell_timeout_ms": 5000,
    "task_timeout_ms": 300000,
    "interrupt_grace_ms": 1000,
    "queue_capacity": 16,
    "max_code_bytes": 128 * 1024,
    "max_frame_bytes": 1024**2,
    "max_output_bytes": 8 * 1024**2,
    "max_artifact_bytes": 512 * 1024,
    "max_artifacts_bytes": 16 * 1024**2,
    "preview_chars": 4000,
}


class Wire:
    def __init__(self, path):
        env = {
            **os.environ,
            "PYTHONPATH": str(ROOT / "python"),
            "JUPYTER_RUNTIME_DIR": str(path / "runtime"),
        }
        workspace = path / "workspace"
        workspace.mkdir()
        self.diagnostics = (path / "stderr.log").open("w+")
        self.process = subprocess.Popen(
            [
                "uv",
                "run",
                "--offline",
                "--no-sync",
                "--project",
                str(ROOT),
                "python",
                "-m",
                "statigent_runtime.bridge",
            ],
            cwd=workspace,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.diagnostics,
            text=True,
        )
        self.messages = queue.Queue()
        self.counter = 0
        self.epoch = 1
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def send(self, kind, **payload):
        self.counter += 1
        identity = f"r{self.counter}"
        self.process.stdin.write(
            json.dumps(
                dict(
                    protocol_version=1,
                    session_id="test",
                    request_id=identity,
                    type=kind,
                    **payload,
                )
            )
            + "\n"
        )
        self.process.stdin.flush()
        return identity

    def until(self, kind, timeout=40):
        deadline = time.monotonic() + timeout
        messages = []
        while time.monotonic() < deadline:
            message = self.messages.get(timeout=deadline - time.monotonic())
            if message is None:
                self.diagnostics.seek(0)
                pytest.fail(f"bridge closed unexpectedly: {self.diagnostics.read()}")
            messages.append(message)
            if message["type"] == kind:
                return messages
        raise AssertionError("bridge result timed out")

    def execute(self, code):
        self.sequence += 1
        return self.send(
            "execute",
            code=code,
            cell_id=f"c{self.sequence}",
            kernel_epoch=self.epoch,
            execution_seq=self.sequence,
        )

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdout.close()
        self.diagnostics.close()


@pytest.fixture
def wire(tmp_path):
    bridge = Wire(tmp_path)
    try:
        bridge.send("init", kernel_epoch=1, seed=42, limits=LIMITS)
        assert bridge.until("ready")[-1]["dependencies"]["python"] == "3.12.9"
        yield bridge
    finally:
        bridge.close()


def text(messages):
    return "".join(m.get("output", {}).get("text", "") for m in messages)


def test_persistence_partial_error_input_and_rich_output(wire):
    wire.execute("value=21\nraise ValueError('expected')")
    assert wire.until("result")[-1]["status"] == "error"
    wire.execute("print(value * 2)")
    messages = wire.until("result")
    assert "42" in text(messages)
    assert messages[-1]["status"] == "ok"
    wire.execute("input('should not wait')")
    result = wire.until("result")[-1]
    assert result["status"] == "error"
    assert result["error"]["ename"] == "StdinNotImplementedError"
    wire.execute(
        "import pandas as pd\nimport matplotlib.pyplot as plt\n"
        "import sys\nprint('stderr-marker', file=sys.stderr)\n"
        "from IPython.display import display, clear_output\n"
        "display(pd.DataFrame({'n':[1,2]}))\n"
        "handle=display('first', display_id='x'); handle.update('second')\n"
        "clear_output(wait=True)\n"
        "plt.plot([1,2]); plt.show()"
    )
    messages = wire.until("result")
    assert messages[-1]["status"] == "ok"
    outputs = [m["output"] for m in messages if m["type"] == "output"]
    assert any("text/html" in item.get("data", {}) for item in outputs)
    assert any("image/png" in item.get("data", {}) for item in outputs)
    assert any(item["output_type"] == "clear_output" for item in outputs)
    assert any(item["output_type"] == "update_display_data" for item in outputs)
    assert any(
        item.get("name") == "stderr" and "stderr-marker" in item["text"]
        for item in outputs
    )


def test_interrupt_and_restart(wire):
    target = wire.execute(
        "import time\nvalue=7\nprint('started',flush=True)\ntime.sleep(60)"
    )
    wire.until("output")
    wire.send("interrupt", target_request_id=target, reason="timed_out")
    result = wire.until("result")[-1]
    assert result["status"] == "timed_out"
    assert result["kernel_available"]
    wire.execute("print(value)")
    assert "7" in text(wire.until("result"))
    wire.send("restart", kernel_epoch=2)
    assert wire.until("control")[-1]["files_preserved"]
    wire.epoch = 2
    wire.execute("print(value)")
    assert wire.until("result")[-1]["error"]["ename"] == "NameError"


def test_late_output_not_attributed_to_next_cell(wire):
    wire.execute(
        "import threading,time\n"
        "def late():\n time.sleep(.5)\n print('LATE-MARKER',flush=True)\n"
        "threading.Thread(target=late).start()"
    )
    assert wire.until("result")[-1]["status"] == "ok"
    wire.execute("time.sleep(1)\nprint('CURRENT')")
    messages = wire.until("result")
    assert "CURRENT" in text(messages)
    assert "LATE-MARKER" not in text(messages)
    assert any(m["type"] == "diagnostic" and "late" in m["message"] for m in messages)


def test_output_limit_interrupts_and_preserves_prefix(wire):
    wire.execute("for i in range(10000):\n print('x'*4096,flush=True)")
    messages = wire.until("result")
    result = messages[-1]
    assert result["status"] == "output_limit_exceeded"
    assert not result["persistence_complete"]
    assert any(m["type"] == "output" for m in messages)


def test_single_oversized_rich_message_is_explicit_limit(wire):
    wire.execute(
        "from IPython.display import display\n"
        "display({'text/plain':'x'*9000000}, raw=True)"
    )
    result = wire.until("result")[-1]
    assert result["status"] == "output_limit_exceeded"
    assert not result["persistence_complete"]
