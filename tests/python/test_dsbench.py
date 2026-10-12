import pytest
from statigent_evaluation.bridge import handle
from statigent_evaluation.dsbench import judge_prompt, parse_verdict


@pytest.mark.parametrize(
    ("reply", "correct"),
    [
        ("True", True),
        ("TRUE.", True),
        ("  true\n", True),
        ("False", False),
        ("Flase", False),  # upstream's own typo in the instruction
        ("", False),
        ("I cannot tell", False),
        # Upstream checks a substring, so "untrue" counts as right; kept verbatim.
        ("untrue", True),
    ],
)
def test_verdict_follows_upstream_substring_rule(reply, correct):
    assert parse_verdict(reply) is correct


def test_prompt_and_reference_formatting_match_upstream():
    text = judge_prompt("Q?", "B", "the answer is B")
    assert text.startswith("Please judge whether the generated answer is right")
    assert "The question is Q?. The true answer is \n B. \n The predicted" in text
    assert "Otherwise output Flase. Don't output any other text content." in text
    request = {"operation": "dsbench_prompt", "question": "Q", "prediction": "p"}
    for answer, rendered in [
        (7, "7"),
        (0.5, "0.5"),
        (1.0, "1.0"),
        ({"k": 1}, "{'k': 1}"),
    ]:
        assert f"\n {rendered}. \n" in handle({**request, "answer": answer})["text"]
    for bad in [True, None, [1]]:
        with pytest.raises(ValueError):
            handle({**request, "answer": bad})
    with pytest.raises(ValueError):
        handle({"operation": "dsbench_verdict", "reply": "x", "extra": 1})
