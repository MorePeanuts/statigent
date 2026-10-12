import json

import pytest
from statigent_evaluation import dacomp
from statigent_evaluation.bridge import handle


def _rubric(total, dims):
    items = [{"criterion_type": k, "score": v} for k, v in dims.items()]
    return "```json\n" + json.dumps({"items": items, "total_score": total}) + "\n```"


def _gsb(read, prof, vis):
    return json.dumps(
        {
            "Readability": {"score": read},
            "Analytical Depth": {"score": prof},
            "Insight Presentation & Visualization": {"score": vis},
        }
    )


@pytest.fixture
def instance(tmp_path):
    (tmp_path / "metadata.json").write_text(
        json.dumps({"Total": 22, "Completeness": 8, "Accuracy": 6, "Conclusiveness": 8})
    )
    return tmp_path


def test_weighted_total_matches_the_documented_example(instance):
    # R = 11/22 = 0.5 and every GSB dimension 3 better, 1 tie, 1 worse -> 0.4.
    gsb = [_gsb(5, 5, 5)] * 3 + [_gsb(0, 0, 0), _gsb(-5, -5, -5)]
    result = dacomp.combine(
        {
            "instance_dir": str(instance),
            "rubric": _rubric(
                11, {"completeness": 4, "accuracy": 3, "Conclusiveness": 4}
            ),
            "gsb_text": gsb,
            "gsb_vision": gsb,
            "compat_rubric": None,
        }
    )
    metrics = result["metrics"]
    assert metrics["total"] == pytest.approx(46)
    assert metrics["rubric_ratio"] == pytest.approx(0.5)
    assert metrics["readability"] == pytest.approx(0.4)
    assert metrics["completeness"] == pytest.approx(50)
    assert metrics["accuracy"] == pytest.approx(50)
    assert result["compat"] is None


def test_gsb_threshold_boundaries_and_floor():
    assert dacomp.trans_gsb_score([3, -3, 3.0001, -3.0001]) == pytest.approx(0)
    assert dacomp.trans_gsb_score([3.0001]) == 1.0
    assert dacomp.trans_gsb_score([-3.0001]) == 0.0  # mean -1 is floored at 0
    assert dacomp.trans_gsb_score([None, None]) is None
    # A missing dimension counts as -10, i.e. a loss.
    assert (
        dacomp.extract_gsb_scores(json.dumps({"Readability": 4}))["professionalism"]
        == -10.0
    )


def test_no_images_scores_visualization_zero_and_missing_dimensions(instance):
    result = dacomp.combine(
        {
            "instance_dir": str(instance),
            "rubric": json.dumps({"total_score": 22}),
            "gsb_text": [_gsb(5, 5, 5)] * 5,
            "gsb_vision": None,
            "compat_rubric": json.dumps({"total_score": 11}),
        }
    )
    assert result["metrics"]["visualization"] == 0
    assert result["metrics"]["total"] == pytest.approx(80)
    # No dimension labels in the reply: all dimensions are 0, as upstream.
    assert result["metrics"]["completeness"] == 0
    assert result["compat"]["rubric_ratio"] == pytest.approx(0.5)
    assert result["compat"]["total"] == pytest.approx(50)


def test_json_blocks_and_validity():
    fenced = 'Here:\n```json\n{"total_score": 7}\n```\nthanks'
    assert dacomp.extract_total_score(fenced) == 7
    assert dacomp.extract_total_score('"总得分": 5') == 5
    assert dacomp.extract_total_score('{"score": +3}') == 3
    assert dacomp.valid_rubric(fenced)
    assert not dacomp.valid_rubric("no json")
    assert not dacomp.valid_rubric('{"comment": "no total"}')
    assert dacomp.valid_gsb("{}")
    assert not dacomp.valid_gsb("[1]")
    assert handle({"operation": "dacomp_valid", "kind": "gsb", "reply": "x"}) == {
        "valid": False
    }
    with pytest.raises(ValueError):
        handle({"operation": "dacomp_valid", "kind": "other", "reply": "x"})


def test_prepare_builds_rubric_text_and_vision_items(tmp_path):
    (tmp_path / "rubric.txt").write_text("R1 [2 points]")
    for k in range(5):
        ref = tmp_path / f"gsb_ref_{k}"
        ref.mkdir()
        (ref / "r.md").write_text(f"ref {k}\n![c](c.png)\n![x](../escape.png)")
        (ref / "c.png").write_bytes(b"png")
    (tmp_path / "escape.png").write_bytes(b"png")
    report = tmp_path / "report.md"
    report.write_text("my report\n")
    items = dacomp.prepare(
        {
            "instance_dir": str(tmp_path),
            "report_path": str(report),
            "report_images": ["/frozen/chart.png"],
            "query": "Q?",
            "trajectory_path": None,
        }
    )["items"]
    assert [i["label"] for i in items][:2] == ["rubric", "gsb_text:gsb_ref_0"]
    assert sum(i["role"] == "gsb_vision" for i in items) == 5
    rubric_text = items[0]["parts"][0]["text"]
    assert '"content": "my report"' in rubric_text and "R1 [2 points]" in rubric_text
    vision = items[-1]["parts"]
    images = [p["path"] for p in vision if p["type"] == "image"]
    assert images[0] == "/frozen/chart.png"
    # Reference images outside their reference folder are not sent.
    assert all("escape" not in p for p in images)
    assert {"type": "text", "text": "\n[参考报告图片附件]"} in vision
    no_images = dacomp.prepare(
        {
            "instance_dir": str(tmp_path),
            "report_path": str(report),
            "report_images": [],
            "query": "Q?",
            "trajectory_path": str(report),
        }
    )["items"]
    assert not any(i["role"] == "gsb_vision" for i in no_images)
    assert no_images[-1]["label"] == "compat_rubric"
