"""Offline command fixture, not a real benchmark agent."""

import base64
import csv
import json
import os
import socket
import sys
import time
from pathlib import Path


def main():
    request = json.loads(sys.stdin.buffer.readline(262145))
    mode = sys.argv[1] if len(sys.argv) > 1 else "sum"
    if mode == "sleep":
        time.sleep(120)
    if mode == "probe":
        assert not Path("/var/run/docker.sock").exists()
        assert not Path("/input/private").exists()
        assert not Path("/input/labels.jsonl").exists()
        assert "DEEPSEEK_API_KEY" not in os.environ
        try:
            socket.create_connection(("1.1.1.1", 443), timeout=0.2)
        except OSError:
            pass
        else:
            raise AssertionError("Network unexpectedly available")
    path = Path(request["input_root"]) / request["task"]["inputs"][0]["path"]
    with path.open() as source:
        total = sum(float(row["value"]) for row in csv.DictReader(source))
    response = {
        "schema_version": 1,
        "unit_id": request["unit_id"],
        "status": "completed",
        "answer_text": f"@sum[{total:g}]",
        "reason": "offline-fixture",
        "artifacts": [
            {
                "name": "result.txt",
                "base64": base64.b64encode(str(total).encode()).decode(),
            }
        ],
        "native_run": None,
        "usage": {
            "source": "not_applicable",
            "attempts": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "unknown_attempts": 0,
            "currency_cost": "not_computed",
        },
        "cleanup_error": None,
        "record_error": False,
    }
    print(json.dumps(response))


if __name__ == "__main__":
    main()
