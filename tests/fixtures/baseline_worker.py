"""受控 worker，验证真实 uv 子进程边界；不导入可选上游。"""

import json
import os
import sys
import threading

from statigent_baselines.bridge import Bridge

view = json.loads(sys.stdin.buffer.readline())
bridge = Bridge(view["run_id"])
if view["goal"] == "crash":
    raise RuntimeError("controlled worker crash")
if view["goal"] == "exit-during-execution":
    threading.Timer(0.3, lambda: os._exit(3)).start()
assert "OPENAI_API_KEY" not in os.environ
assert "BASELINE_SENTINEL_SECRET" not in os.environ
assert "CUSTOM_CONFIG" not in os.environ
bridge.request(
    "execution.execute",
    code=("import time; time.sleep(30)" if view["goal"] in (
        "exit-during-execution", "cancel-during-execution", "timeout-during-execution"
    ) else "print('container only')"),
)
bridge.request("submission.finish", submission={"kind": "text", "answer": "done"})
