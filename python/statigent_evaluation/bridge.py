"""One bounded request per scorer process; never executes submitted code."""

import json
import sys

from .infiagent import PROTOCOL, score


def handle(request):
    if isinstance(request, dict) and request.get("operation") == "aggregate":
        if set(request) != {"operation", "scores"} or not isinstance(
            request["scores"], list
        ):
            raise ValueError("Invalid aggregate request")
        eligible = [s for s in request["scores"] if s["details"]["answered"]]
        return {
            "answered": len(eligible),
            "abq": round(sum(s["details"]["abq"] for s in eligible) / len(eligible), 4)
            if eligible
            else 0,
            "psaq": round(
                sum(s["details"]["psaq"] for s in eligible) / len(eligible), 4
            )
            if eligible
            else 0,
            "denominator": "nonempty-final-answers",
            "deviation": "primary includes terminal failures",
        }
    if (
        not isinstance(request, dict)
        or set(request) != {"schema_version", "unit_id", "answers", "answer_text"}
        or request["schema_version"] != 1
        or not isinstance(request["unit_id"], str)
    ):
        raise ValueError("Invalid scoring request")
    result = score(request["answers"], request["answer_text"])
    return {
        "schema_version": 1,
        "unit_id": request["unit_id"],
        "protocol": PROTOCOL,
        "status": "scored",
        "metrics": [
            {
                "name": name,
                "value": result[name],
                "minimum": 0,
                "maximum": 1,
                "direction": "higher",
            }
            for name in ["abq", "psaq"]
        ],
        "details": result,
        "error": None,
    }


def main():
    try:
        raw = sys.stdin.buffer.read(262145)
        if len(raw) > 262144:
            raise ValueError("Request size exceeded")
        print(json.dumps(handle(json.loads(raw)), allow_nan=False))
    except (ValueError, TypeError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
