"""InfiAgent comparison semantics, adapted from Apache-2.0 upstream.

Source: InfiAgent/InfiAgent, commit 3d6c4a70198e0a41fadf539f5b43c88b8c1a2d9c,
examples/DA-Agent/eval_closed_form.py. See third_party/infiagent/LICENSE.
Changes: explicit validation, per-unit results and missing-answer zero scores.
"""

import re

PROTOCOL = "infiagent-fixed-denominator-v1"


def validate_answers(value):
    if not isinstance(value, list) or not value:
        raise ValueError("Nonempty answers required")
    result = {}
    for pair in value:
        if (
            not isinstance(pair, list)
            or len(pair) != 2
            or not all(isinstance(item, str) for item in pair)
            or not pair[0]
            or pair[0] in result
        ):
            raise ValueError("Invalid or duplicate answer definition")
        result[pair[0]] = pair[1]
    return result


def is_equal(response, label):
    if response == label:
        return True
    try:
        return abs(float(response) - float(label)) < 1e-6
    except (TypeError, ValueError, OverflowError):
        return False


def score(answers, answer_text):
    labels = validate_answers(answers)
    if not isinstance(answer_text, str):
        raise ValueError("Answer must be text")
    extracted = dict(re.findall(r"@(\w+)\[(.*?)\]", answer_text))
    correctness = {name: is_equal(extracted.get(name), v) for name, v in labels.items()}
    return {
        "abq": int(all(correctness.values())),
        "psaq": sum(correctness.values()) / len(labels),
        "correctness": correctness,
        "answered": bool(answer_text),
    }
