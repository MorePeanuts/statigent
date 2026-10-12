"""Explicit local-resource differential check for DSBench-Analysis judging.

The upstream script creates an OpenAI client and runs its whole loop at import time,
so only `evaluate_prediction` is lifted out with `ast` and executed against a stub
client that records the prompt. The upstream file itself is never modified.
"""

import ast
import types
from pathlib import Path

import pytest
from statigent_evaluation.dsbench import judge_prompt, parse_verdict

pytestmark = pytest.mark.upstream
SOURCE = Path("benchmarks/dsbench/upstream/data_analysis/compute_answer.py")


def _upstream_evaluate():
    assert SOURCE.is_file(), "Prepare local DSBench resources first; no download"
    tree = ast.parse(SOURCE.read_text())
    function = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "evaluate_prediction"
    )
    namespace = {}
    exec(
        compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), "exec"),
        namespace,
    )
    return namespace["evaluate_prediction"]


class _Recorder:
    def __init__(self):
        self.calls = []
        self.chat = types.SimpleNamespace(completions=self)

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = types.SimpleNamespace(content="True")
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])


@pytest.mark.parametrize(
    ("question", "answer", "prediction"),
    [
        ("Question 1 What is X?  a. 1 b. 2", "B", "The answer is b. 2"),
        ("How many?", str(1661626), "1,661,626"),
        ("Word table", str({"Q": 1, "# of words": 7}), "7 words"),
    ],
)
def test_prompt_matches_upstream(question, answer, prediction):
    client = _Recorder()
    _upstream_evaluate()(client, question, answer, prediction)
    (call,) = client.calls
    assert call["model"] == "gpt-4o-2024-05-13"
    assert call["temperature"] == 0
    (message,) = call["messages"]
    assert message["content"] == [
        {"type": "text", "text": judge_prompt(question, answer, prediction)}
    ]


def test_verdict_reduction_matches_upstream_source():
    text = SOURCE.read_text()
    assert 'if "true" in result.lower():' in text
    for reply in ["True", "False", "Flase", "untrue", ""]:
        assert parse_verdict(reply) is ("true" in reply.lower())
