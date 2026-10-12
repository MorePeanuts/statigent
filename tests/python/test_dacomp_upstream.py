"""Explicit local-resource differential check for DAComp-DA scoring.

Upstream modules are imported unmodified with stubs for their network and logging
dependencies (llm_client, loguru, tenacity); no model is called.
"""

import base64
import json
import sys
import types
from pathlib import Path

import pandas as pd
import pytest
from statigent_evaluation import dacomp, dacomp_prompts

pytestmark = pytest.mark.upstream
SUITE = Path("benchmarks/dacomp-da/evaluator/upstream/dacomp-da/evaluation_suite")


@pytest.fixture
def upstream(monkeypatch):
    assert SUITE.is_dir(), "Prepare local DAComp resources first; no download"

    class _Logger:
        def __getattr__(self, _name):
            return lambda *args, **kwargs: None

    loguru = types.ModuleType("loguru")
    loguru.logger = _Logger()
    client = types.ModuleType("core.llm_client")
    client.llm_completion = lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("no model calls in differential tests")
    )
    monkeypatch.setitem(sys.modules, "loguru", loguru)
    monkeypatch.setitem(sys.modules, "tenacity", types.ModuleType("tenacity"))
    monkeypatch.setitem(sys.modules, "core.llm_client", client)
    for name in [n for n in sys.modules if n == "core" or n.startswith("core.")]:
        if name != "core.llm_client":
            monkeypatch.delitem(sys.modules, name)
    monkeypatch.syspath_prepend(str(SUITE.resolve()))
    import core.pipeline as pipeline
    import core.prompts as prompts
    import core.rubric_scoring as scoring
    import core.tasks as tasks
    import core.tasks_loader as loader

    return types.SimpleNamespace(
        prompts=prompts, tasks=tasks, scoring=scoring, loader=loader, pipeline=pipeline
    )


def test_templates_are_verbatim(upstream):
    for name in ("RUBRIC_PROMPT_EN", "GSB_PROMPT_TEXT_EN", "GSB_PROMPT_VIS_EN"):
        assert getattr(dacomp_prompts, name) == getattr(upstream.prompts, name)


def _task(upstream, instance, report, trajectory=""):
    meta = upstream.loader.load_task_metadata(instance.parent)[instance.name]
    refs = {k: v for k, v in meta["gsb_refs"].items() if v}
    images = {k: [Path(p) for p in v] for k, v in meta["gsb_ref_images"].items()}
    return upstream.tasks.EvaluationTask(
        instance_id=instance.name,
        model_name="m",
        query="Q?",
        rubrics=meta["rubrics"],
        trajectory=trajectory,
        answer=report.read_text().strip(),
        answer_images=[report.parent / "chart.png"],
        reference_reports=refs,
        reference_images=images,
        rubric_prompt_template=upstream.prompts.RUBRIC_PROMPT_EN,
    )


def _ours(parts):
    out = []
    for p in parts:
        if p["type"] == "text":
            out.append(("text", p["text"]))
        else:
            out.append(("image", Path(p["path"]).read_bytes()))
    return out


def _theirs(segments):
    out = []
    for s in segments:
        if s["type"] == "text":
            out.append(("text", s["text"]))
        else:
            data = s["image_url"]["url"].split(",", 1)[1]
            out.append(("image", base64.b64decode(data)))
    return out


def test_prompts_and_images_match_upstream_tasks(upstream, tmp_path):
    instance = (SUITE / "src" / "dacomp-002").resolve()
    report = tmp_path / "report.md"
    report.write_text("# Candidate\n\nSales grew.\n![Trend](chart.png)\n")
    (tmp_path / "chart.png").write_bytes(b"\x89PNG candidate")
    task = _task(upstream, instance, report)
    items = dacomp.prepare(
        {
            "instance_dir": str(instance),
            "report_path": str(report),
            "report_images": [str(tmp_path / "chart.png")],
            "query": "Q?",
            "trajectory_path": None,
        }
    )["items"]
    by_label = {i["label"]: i for i in items}
    (rubric_message,) = task.rubrics_prompt()
    assert _ours(by_label["rubric"]["parts"]) == _theirs(rubric_message["content"])
    for channel, template, include in [
        ("gsb_text", upstream.prompts.GSB_PROMPT_TEXT_EN, False),
        ("gsb_vision", upstream.prompts.GSB_PROMPT_VIS_EN, True),
    ]:
        for key, (message,) in task.gsb_prompts(template, include):
            ours = _ours(by_label[f"{channel}:{key}"]["parts"])
            assert ours == _theirs(message["content"])
    trajectory_task = _task(upstream, instance, report, trajectory="step 1\nstep 2")
    (trajectory_path := tmp_path / "trajectory.txt").write_text("step 1\nstep 2\n")
    compat = dacomp.prepare(
        {
            "instance_dir": str(instance),
            "report_path": str(report),
            "report_images": [],
            "query": "Q?",
            "trajectory_path": str(trajectory_path),
        }
    )["items"][-1]
    (message,) = trajectory_task.rubrics_prompt()
    assert _ours(compat["parts"]) == _theirs(message["content"])


SAMPLES = [
    "```json\n"
    + json.dumps({"总得分": 12, "items": [{"标准类型": "完备性", "得分": 3}]})
    + "\n```",
    json.dumps(
        {
            "requirements": [
                {"criterion_type": "Accuracy", "score": 2},
                {"dimension": "conclusiveness", "score": "1.5"},
            ],
            "total_score": 7,
        }
    ),
    'noise "score": 4 and total_score: 6',
    '{"Readability": {"score": 6}, "Analytical Depth": 2, "total_score": +3}',
    "",
]


@pytest.mark.parametrize("reply", SAMPLES)
def test_reply_parsing_matches_upstream(upstream, reply):
    assert dacomp.extract_total_score(reply) == upstream.tasks.extract_total_score(
        reply
    )
    assert dacomp.parse_rubric_dimension_scores(
        reply
    ) == upstream.scoring.parse_rubric_dimension_scores(reply)
    if reply:
        theirs = upstream.scoring.extract_gsb_scores(reply)
        ours = dacomp.extract_gsb_scores(reply)
        for key in ("readability", "professionalism", "visualization"):
            assert ours[key] == theirs[key]
    assert dacomp.valid_rubric(reply) == (
        upstream.tasks.is_valid_rubrics_response(reply)
        and upstream.tasks.extract_total_score(reply) is not None
    )
    assert dacomp.valid_gsb(reply) == upstream.tasks.is_valid_gsb_response(reply)


@pytest.mark.parametrize(
    "scores", [[5, 0, -5, 3, -3], [10, 10], [-10], [None, 4], [3.0001, -3.0001]]
)
def test_gsb_mapping_matches_upstream(upstream, scores):
    assert dacomp.trans_gsb_score(scores) == upstream.scoring.trans_gsb_score(scores)


def test_weighted_total_matches_upstream(upstream):
    row = {
        "rubrics_percentage": 50.0,
        "gsb_readability_score": 0.4,
        "gsb_professionalism_score": 0.2,
        "gsb_visualization_score": 1.0,
    }
    frame = pd.DataFrame([row])
    upstream.scoring.compute_weighted_total(frame)
    gsb = {"readability": 0.4, "professionalism": 0.2, "visualization": 1.0}
    assert dacomp._weighted(50.0, gsb) == pytest.approx(
        frame.loc[0, "weighted_total_score"]
    )
    assert upstream.scoring.WEIGHTED_COMPONENTS == (
        ("rubrics_percentage", 0.60, 1.0),
        ("gsb_readability_score", 0.10, 100.0),
        ("gsb_professionalism_score", 0.10, 100.0),
        ("gsb_visualization_score", 0.20, 100.0),
    )


def test_no_image_visualization_rule_matches_upstream(upstream):
    zero = upstream.pipeline.NO_IMAGE_VIS_RESULT_TEXT
    assert upstream.scoring.extract_gsb_scores(zero)["visualization"] == 0
    assert dacomp.trans_gsb_score([0.0] * 5) == upstream.scoring.trans_gsb_score(
        [upstream.scoring.extract_gsb_scores(zero)["visualization"]] * 5
    )
