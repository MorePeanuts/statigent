"""DSBench-Analysis answer judging, adapted from MIT-licensed upstream.

Source: LiqiangJing/DSBench, commit ba786096137a5108af11c016ad3f09cdb97beefd,
data_analysis/compute_answer.py (evaluate_prediction and the True/False reduction).
See third_party/dsbench/LICENSE. Changes: the prompt text is kept verbatim but built
here instead of sending it; the judge call itself is made by the host with a
configurable model, and a failed call is a scoring error instead of "False".
"""

PROTOCOL = "dsbench-analysis-judge-v1"


def judge_prompt(question, answer, prediction):
    # Verbatim upstream wording, including its "Flase" typo, so judges see the
    # same text.
    return (
        "Please judge whether the generated answer is right or wrong. We require "
        "that the correct answer "
        "to the prediction gives a clear answer, not just a calculation process or "
        "a disassembly of ideas. "
        f"The question is {question}. The true answer is \n {answer}. \n The "
        f"predicted answer is \n {prediction}.\n "
        "If the predicted answer is right, please output True. Otherwise output "
        "Flase. "
        "Don't output any other text content. You only can output True or False."
    )


def parse_verdict(reply):
    """Upstream rule: any reply containing "true" (case-insensitive) counts as right."""
    if not isinstance(reply, str):
        raise ValueError("Verdict must be text")
    return "true" in reply.lower()
