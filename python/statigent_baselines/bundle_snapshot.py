"""在任务容器内停止执行进程后流式快照 tmpfs；不加载模型或生成入口。"""

import os
import signal
import sys
import tarfile
import time
from pathlib import Path


def snapshot(bundle, max_files, max_bytes):
    # Docker exec 的 uv/Python 是受信快照祖先；PID 1 是固定镜像的 uv 启动器。
    if b"uv" not in Path("/proc/1/cmdline").read_bytes().split(b"\0")[0]:
        raise RuntimeError("Unexpected container init")
    allowed = {1, os.getpid()}
    parent = os.getppid()
    while parent not in allowed and parent > 0:
        allowed.add(parent)
        stat = Path(f"/proc/{parent}/stat").read_text().rsplit(")", 1)[1].split()
        parent = int(stat[1])

    def processes():
        return [
            int(p.name)
            for p in Path("/proc").iterdir()
            if p.name.isdigit() and int(p.name) not in allowed
        ]

    # 两次确认全部停止；未知/不可停止的进程使快照失败。永远不恢复生成进程。
    for _ in range(8):
        pending = []
        for pid in processes():
            try:
                state = (
                    Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
                )
                if state not in ("T", "t", "Z", "X"):
                    os.kill(pid, signal.SIGSTOP)
                    pending.append(pid)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
        if not pending:
            break
        time.sleep(0.01)
    else:
        raise RuntimeError("Unable to quiesce task processes")
    for pid in processes():
        try:
            state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            if state not in ("T", "t", "Z", "X"):
                raise RuntimeError("Task process still running")
        except FileNotFoundError:
            pass
    root = Path("/tmp/baseline-models") / bundle
    if root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError("Unsafe model bundle root")
    files, count, size = [], 0, 0
    for path in sorted(root.rglob("*")):
        if len(files) >= max_files * 4 or path.is_symlink():
            raise ValueError("Bundle entry limit or symlink")
        if path.is_file():
            count += 1
            size += path.stat().st_size
        elif not path.is_dir():
            raise ValueError("Nonregular bundle member")
        if count > max_files or size > max_bytes:
            raise ValueError("Bundle size limit")
        files.append(path)
    if count == 0:
        raise ValueError("Empty bundle")
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        for path in files:
            archive.add(path, arcname=str(path.relative_to(root)), recursive=False)


if __name__ == "__main__":
    snapshot(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
