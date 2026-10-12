"""One bounded request per scorer process; never executes submitted code."""

import json
import sys

from . import dsbench
from .infiagent import PROTOCOL, score


def _fields(request, names):
    if set(request) != {"operation", *names}:
        raise ValueError("Invalid request fields")
    return [request[name] for name in names]


def handle(request):
    operation = request.get("operation") if isinstance(request, dict) else None
    if operation == "dsbench_prompt":
        question, answer, prediction = _fields(
            request, ["question", "answer", "prediction"]
        )
        # Upstream formats the reference with str() (dicts print as Python reprs).
        if (
            not isinstance(question, str)
            or not isinstance(prediction, str)
            or isinstance(answer, bool)
            or not isinstance(answer, (str, int, float, dict))
        ):
            raise ValueError("Invalid DSBench prompt request")
        return {"text": dsbench.judge_prompt(question, str(answer), prediction)}
    if operation == "dsbench_verdict":
        (reply,) = _fields(request, ["reply"])
        return {"correct": dsbench.parse_verdict(reply)}
    if operation == "aggregate":
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
