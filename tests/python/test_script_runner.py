"""Trusted synthetic scripts exercise fresh runner behavior without Docker."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest
from statigent_runtime.script_bridge import parse_request

RUNNER = (
    Path(__file__).resolve().parents[2] / "python/statigent_runtime/script_runner.py"
)


def run_script(workspace, code):
    source = workspace / "attempt.py"
    source.write_text(code)
    with tempfile.TemporaryFile() as events:
        result = subprocess.run(
            [
                "uv",
                "run",
                "--offline",
                "--no-sync",
                "python",
                str(RUNNER),
                str(source),
                "42",
                str(events.fileno()),
                "1048576",
            ],
            cwd=workspace,
            env={**os.environ, "UV_PROJECT": str(RUNNER.parents[2])},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            pass_fds=(events.fileno(),),
            timeout=15,
        )
        events.seek(0)
        frames = [json.loads(line) for line in events]
    return result, frames


def test_state_seed_files_and_errors(tmp_path):
    first, frames = run_script(
        tmp_path,
        "import os,random,numpy as np\nx=42\n"
        "os.environ['FRESH_TEST']='changed'\nopen('kept.txt','w').write('value')\n"
        "print(random.random(),np.random.random())",
    )
    second, _ = run_script(
        tmp_path,
        "import os,random,numpy as np\n"
        "assert 'x' not in globals()\nassert 'FRESH_TEST' not in os.environ\n"
        "assert open('kept.txt').read()=='value'\n"
        "print(random.random(),np.random.random())",
    )
    assert first.returncode == second.returncode == 0
    assert first.stdout == second.stdout
    assert frames[-1]["status"] == "ok"
    failed, frames = run_script(
        tmp_path, "open('partial.txt','w').write('partial')\nraise ValueError('test')"
    )
    assert failed.returncode == 1
    assert frames[-1]["error"]["ename"] == "ValueError"
    assert (tmp_path / "partial.txt").read_text() == "partial"


def test_display_script_semantics_and_input(tmp_path):
    result, frames = run_script(
        tmp_path,
        "from IPython.display import display\nimport pandas as pd\n"
        "display(pd.DataFrame({'x':[1]}))\nprint('{\"type\":\"result\"}')\n987654321",
    )
    assert result.returncode == 0
    assert b"987654321" not in result.stdout
    assert b'{"type":"result"}' in result.stdout
    assert (
        "text/html"
        in next(f for f in frames if f["type"] == "display")["output"]["data"]
    )
    result, frames = run_script(tmp_path, "input('no interaction')")
    assert result.returncode == 1
    assert frames[-1]["error"]["ename"] == "EOFError"


@pytest.mark.parametrize(
    "extra",
    [
        {"protocol_version": 1},
        {"execution_seq": True},
        {"execution_id": None},
        {"command": "bash"},
        {"code": 42},
    ],
)
def test_reject_invalid_requests(extra):
    value = {
        "protocol_version": 2,
        "backend": "fresh-script",
        "type": "execute",
        "request_id": "r",
        "session_id": "s",
        "execution_id": "e",
        "execution_seq": 1,
        "code": "print(1)",
        **extra,
    }
    with pytest.raises(ValueError):
        parse_request(json.dumps(value).encode(), 1048576)
