"""Validate exported notebooks independently with the official nbformat schema."""

import argparse
import json
import sys
from pathlib import Path

import nbformat


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["validate"])
    parser.add_argument("path")
    args = parser.parse_args()
    try:
        raw = sys.stdin.read() if args.path == "-" else Path(args.path).read_text()
        notebook = nbformat.reads(raw, as_version=nbformat.NO_CONVERT)
        nbformat.validate(notebook)
    except (ValueError, OSError, nbformat.ValidationError) as exc:
        print(json.dumps({"valid": False, "error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps({"valid": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
