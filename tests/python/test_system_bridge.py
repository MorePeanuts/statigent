import json
import subprocess
import threading
import time

import pytest
from statigent_benchmarks.system_bridge import SystemBridge


def use_bun(monkeypatch, code):
    original = subprocess.Popen

    def start(args, **kwargs):
        assert args == ["bun", "run", "src/modeling/system-bridge.ts"]
        assert kwargs["start_new_session"] is True
        return original(["bun", "-e", code], **kwargs)

    monkeypatch.setattr(subprocess, "Popen", start)


def test_bridge_identity_and_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("PRIVATE_VALUE", "not-passed")
    use_bun(
        monkeypatch,
        "const x=JSON.parse(await Bun.stdin.text());"
        "process.stdout.write(JSON.stringify({version:1,request_id:x.request_id,"
        "ok:true,result:{private:process.env.PRIVATE_VALUE??null}}))",
    )
    bridge = SystemBridge(tmp_path, tmp_path / "bridge")
    result = bridge.call("fit", timeout_seconds=2)
    assert result == {"private": None}
    bridge.close()
    with pytest.raises(RuntimeError, match="cancelled"):
        bridge.call("fit", timeout_seconds=2)


@pytest.mark.parametrize(
    "code,match",
    [
        (
            'process.stdout.write(JSON.stringify({version:1,request_id:"wrong",ok:true,result:{}}))',
            "identity",
        ),
        ('process.stdout.write("x".repeat(2**21))', "output.limit"),
        ("setTimeout(()=>{},10000)", "timed_out"),
    ],
)
def test_bridge_bounded_failure(tmp_path, monkeypatch, code, match):
    use_bun(monkeypatch, code)
    bridge = SystemBridge(tmp_path, tmp_path / "bridge")
    with pytest.raises((ValueError, RuntimeError), match=match):
        bridge.call("fit", timeout_seconds=0.3)
    assert bridge.active is None
    bridge.close()


def test_bridge_cancels_only_owned_operation(tmp_path, monkeypatch):
    use_bun(monkeypatch, "setTimeout(()=>{},10000)")
    bridge = SystemBridge(tmp_path, tmp_path / "bridge")
    failures = []

    def execute():
        try:
            bridge.call("fit", timeout_seconds=5)
        except RuntimeError as error:
            failures.append(str(error))

    thread = threading.Thread(target=execute)
    thread.start()
    deadline = time.monotonic() + 2
    while bridge.active is None and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.01)
    with pytest.raises(RuntimeError, match="serialized"):
        bridge.call("predict", timeout_seconds=1)
    bridge.close()
    thread.join(timeout=2)
    assert not thread.is_alive() and "cancelled" in failures[0]
    record = json.loads(next((tmp_path / "bridge").glob("*/bridge.json")).read_text())
    assert record["failure"] == "cancelled" and not record["forced_termination"]
