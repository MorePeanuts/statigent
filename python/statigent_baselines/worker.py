"""固定入口：只运行受信方法，协议 stdout 与上游日志分开。"""

import json
import sys
from contextlib import redirect_stdout

from statigent_baselines.bridge import MAX_REQUEST, Bridge, object_fields


def main():
    initial = sys.stdin.buffer.readline(MAX_REQUEST + 2)
    if len(initial) > MAX_REQUEST + 1 or not initial.endswith(b"\n"):
        raise ValueError("Invalid worker startup frame")
    view = json.loads(initial)
    object_fields(
        view,
        {
            "protocol_version",
            "run_id",
            "method",
            "goal",
            "constraints",
            "files",
            "output",
            "options",
            "seed",
        },
    )
    if view["protocol_version"] != 1 or view["method"] not in (
        "autogen",
        "datawiseagent",
    ):
        raise ValueError("Unsupported worker identity")
    bridge = Bridge(view["run_id"])
    with redirect_stdout(sys.stderr):
        if view["method"] == "autogen":
            from statigent_baselines.autogen_worker import run
        else:
            from statigent_baselines.datawise_worker import run
        run(view, bridge)


if __name__ == "__main__":
    main()
