"""隔离预测启动器：执行冻结入口，拒绝可观察的常见拟合与子进程调用。"""

import argparse
import base64
import hashlib
import json
import os
import runpy
import sys
from contextlib import redirect_stdout
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--entrypoint", required=True)
    parser.add_argument("--max-bytes", type=int, required=True)
    args = parser.parse_args()
    entry = (Path("/bundle") / args.entrypoint).resolve(strict=True)
    if not entry.is_relative_to("/bundle") or not entry.is_file():
        raise ValueError("Invalid frozen entrypoint")
    target = Path("/output/predictions.csv")
    forbidden = []

    def audit(event, _args):
        if event in (
            "subprocess.Popen",
            "os.system",
            "os.fork",
            "os.exec",
            "os.posix_spawn",
        ):
            forbidden.append(event)
            raise RuntimeError("Prediction subprocesses are disabled")

    def profile(frame, event, _arg):
        if event == "call" and frame.f_code.co_name in (
            "fit",
            "partial_fit",
            "fit_transform",
            "fit_predict",
        ):
            forbidden.append(frame.f_code.co_name)
            raise RuntimeError("Fitting is forbidden during prediction")

    sys.argv = [
        str(entry),
        "--features",
        "/input/features.csv",
        "--output",
        str(target),
        "--schema",
        "/input/schema.json",
    ]
    sys.path.insert(0, "/bundle")
    os.chdir("/bundle")
    sys.addaudithook(audit)
    sys.setprofile(profile)
    try:
        with redirect_stdout(sys.stderr):
            runpy.run_path(str(entry), run_name="__main__")
        if forbidden or sys.getprofile() is not profile:
            raise RuntimeError("Prediction audit failed")
    finally:
        sys.setprofile(None)
    if (
        target.is_symlink()
        or not target.is_file()
        or target.stat().st_size > args.max_bytes
    ):
        raise ValueError("Invalid prediction output")
    content = target.read_bytes()
    print(
        json.dumps(
            {
                "version": 1,
                "data_base64": base64.b64encode(content).decode(),
                "sha256": hashlib.sha256(content).hexdigest(),
                "bytes": len(content),
                "audit": {
                    "common_fit_calls": 0,
                    "subprocesses": 0,
                    "scope": "observable-python-calls-v1",
                },
            }
        )
    )


if __name__ == "__main__":
    main()
