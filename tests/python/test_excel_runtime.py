import json
import shutil
import subprocess
from pathlib import Path

import pandas as pd
import pytest
from excel_fixtures import make_xlsb, make_xlsx

EXPECTED = {"group": ["A", "B"], "value": [2.0, 4.0]}


def _fixtures(root: Path) -> Path:
    make_xlsx(root / "data.xlsx")
    make_xlsb(root / "data.xlsb")
    return root


def test_runtime_dependencies_read_synthetic_workbooks(tmp_path):
    root = _fixtures(tmp_path)
    for name, engine in [("data.xlsx", "openpyxl"), ("data.xlsb", "pyxlsb")]:
        frame = pd.read_excel(root / name, engine=engine)
        assert frame.to_dict(orient="list") == EXPECTED


@pytest.mark.integration
def test_runtime_image_reads_xlsx_and_xlsb(tmp_path):
    if shutil.which("docker") is None:
        pytest.fail("docker is required for this integration test")
    root = _fixtures(tmp_path)
    root.chmod(0o755)
    for path in root.iterdir():
        path.chmod(0o644)
    code = (
        "import json, pandas as pd\n"
        "print(json.dumps({n: pd.read_excel('/input/' + n).to_dict(orient='list')"
        " for n in ['data.xlsx', 'data.xlsb']}))"
    )
    result = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            # Same writable scratch mount the execution session provides.
            "--tmpfs",
            "/tmp:rw,mode=1777",
            "--mount",
            f"type=bind,source={root},target=/input,readonly",
            "--entrypoint",
            "uv",
            "statigent-runtime:dev",
            "run",
            "--offline",
            "--no-sync",
            "--project",
            "/opt/runtime",
            "python",
            "-c",
            code,
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    # pandas picks openpyxl/pyxlsb from the file content, as an agent's plain
    # read_excel call would.
    assert json.loads(result.stdout) == {"data.xlsx": EXPECTED, "data.xlsb": EXPECTED}
