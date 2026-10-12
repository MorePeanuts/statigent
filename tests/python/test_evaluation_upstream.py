"""Explicit local-resource differential check; no downloads or model calls."""

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest
from statigent_evaluation.bridge import handle
from statigent_evaluation.infiagent import score

pytestmark = pytest.mark.upstream


def test_upstream_comparison(monkeypatch):
    path = Path(
        "benchmarks/infiagent-dabench/upstream/examples/DA-Agent/eval_closed_form.py"
    )
    assert path.is_file(), (
        "Prepare local InfiAgent resources first; no automatic download"
    )
    shim = types.ModuleType("utils.utils")
    shim.read_jsonl = lambda p: [
        json.loads(s) for s in Path(p).read_text().splitlines()
    ]
    monkeypatch.setitem(sys.modules, "utils", types.ModuleType("utils"))
    monkeypatch.setitem(sys.modules, "utils.utils", shim)
    spec = importlib.util.spec_from_file_location("upstream_infiagent", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    labels = [["a", "1"], ["b", "2"]]
    samples = [
        "@a[1] @b[2]",
        "@a[0] @a[1]",
        "@a[1.000001]",
        "@a[\n1]",
        "nonsense",
        "@a[1e0]",
        "@a[ 1 ]",
    ]
    native = []
    for i, answer in enumerate(samples):
        reference = module.evaluate_responses(
            [{"id": i, "common_answers": labels}], [{"id": i, "response": answer}]
        )[0]
        ours = score(labels, answer)
        assert ours["correctness"] == reference["correctness"]
        native.append(reference)
    ours = handle(
        {
            "operation": "aggregate",
            "scores": [{"details": score(labels, text)} for text in samples],
        }
    )
    assert ours["abq"] == module.evaluate_accuracy_by_question(native)
    assert ours[
        "psaq"
    ] == module.evaluate_accuracy_proportional_by_sub_question_adjusted(native)
    assert module.evaluate_responses([{"id": 0, "common_answers": labels}], []) == []
    assert score(labels, "")["abq"] == 0
