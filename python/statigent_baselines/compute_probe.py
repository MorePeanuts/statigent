"""受限镜像内的依赖、实际训练与资源边界探针。"""

import json
import os
import socket
from importlib.metadata import version
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor
from lightgbm import LGBMRegressor
from sklearn.ensemble import RandomForestRegressor
from xgboost import XGBRegressor


def main():
    assert os.getuid() == 10001
    cpu = Path("/sys/fs/cgroup/cpu.max").read_text().split()
    assert cpu[0] != "max" and int(cpu[0]) / int(cpu[1]) == 2
    memory = Path("/sys/fs/cgroup/memory.max").read_text().strip()
    assert int(memory) == 4 * 1024**3
    try:
        Path("/opt/runtime/forbidden-probe").write_text("forbidden")
    except OSError:
        root_readonly = True
    else:
        raise AssertionError("Root filesystem writable")
    with socket.socket() as sock:
        sock.settimeout(1)
        try:
            sock.connect(("1.1.1.1", 443))
        except OSError:
            network_blocked = True
        else:
            raise AssertionError("Network unexpectedly accessible")
    # /quota 专用小 tmpfs；实际写满验证上限，不能只相信配置声明。
    quota = Path("/quota/fill")
    with quota.open("wb") as stream:
        try:
            for _ in range(9):
                stream.write(b"x" * 1024**2)
                stream.flush()
        except OSError:
            quota_enforced = True
        else:
            raise AssertionError("Workspace quota not enforced")
    quota.unlink()
    x = np.arange(40, dtype=float).reshape(20, 2)
    y = x[:, 0] * 2
    models = [
        LGBMRegressor(n_estimators=5, n_jobs=2, verbosity=-1),
        CatBoostRegressor(iterations=5, thread_count=2, verbose=False),
        XGBRegressor(n_estimators=5, n_jobs=2),
        RandomForestRegressor(n_estimators=5, n_jobs=2, random_state=7),
    ]
    for model in models:
        model.fit(x, y)
        assert np.isfinite(model.predict(x)).all()
    print(
        json.dumps(
            {
                "uid": os.getuid(),
                "cpu_max": cpu,
                "memory_max": memory,
                "root_readonly": root_readonly,
                "network_blocked": network_blocked,
                "write_quota_enforced": quota_enforced,
                "dependencies": {
                    name: version(name)
                    for name in (
                        "numpy",
                        "pandas",
                        "scikit-learn",
                        "lightgbm",
                        "catboost",
                        "xgboost",
                    )
                },
                "trained": [type(model).__name__ for model in models],
            }
        )
    )


if __name__ == "__main__":
    main()
