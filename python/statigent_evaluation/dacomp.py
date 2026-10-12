"""DAComp-DA rubric and GSB scoring, adapted from MIT-licensed upstream.

Source: ByteDance-Seed/DAComp, commit 027ccaf20f0d3743d9291fd575d9bc785a5fe3db,
dacomp-da/evaluation_suite/core/{tasks.py, tasks_loader.py, rubric_scoring.py,
pipeline.py}. See third_party/dacomp/LICENCE. Ported pure functions: prompt
assembly, JSON reply parsing, rubric dimension and total extraction, GSB score
extraction and mapping, and the 0.6/0.1/0.1/0.2 weighted total. Judge calls,
retries and file handling are done by the host. Local deviations are listed in
DEVIATIONS and recorded with every plan.
"""

import json
import math
import re
from pathlib import Path

from .dacomp_prompts import GSB_PROMPT_TEXT_EN, GSB_PROMPT_VIS_EN, RUBRIC_PROMPT_EN

PROTOCOL = "dacomp-da-report-v1"
COMPAT_PROTOCOL = "dacomp-da-upstream-trajectory-v1"
GSB_REF_KEYS = [f"gsb_ref_{idx}" for idx in range(5)]
IMAGE_PATTERN = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
JSON_BLOCK_PATTERN = re.compile(
    r"```json\s*(\{.*?\})\s*```", flags=re.DOTALL | re.IGNORECASE
)
TARGET_KEYS = {"总得分", "总分", "score", "total_score"}
DIMENSION_LABELS = ("Completeness", "Accuracy", "Conclusiveness")
GSB_READABILITY_KEYS = (
    "可读性",
    "可读性评分",
    "报告结构与可读性",
    "Readability",
    "Readability Score",
    "Structure & Readability",
)
GSB_PROFESSIONALISM_KEYS = (
    "分析专业深度",
    "分析专业有深度",
    "分析专业性",
    "分析专业",
    "Analytical Depth",
    "Analytical Professionalism",
    "Analysis Professionalism",
    "Analysis Depth",
)
GSB_VISUALIZATION_KEYS = (
    "洞察呈现与可视化",
    "洞察呈现",
    "可视化表现",
    "洞察呈现",
    "Insight Presentation & Visualization",
    "Insight Presentation",
    "Visualization",
    "Visualizations",
)
GSB_SCORE_FIELDS = ("得分", "score")
WEIGHTS = {
    "rubric": 0.60,
    "readability": 0.10,
    "professionalism": 0.10,
    "visualization": 0.20,
}
DEVIATIONS = [
    "Primary protocol judges the final report only; upstream prefers the "
    "trajectory for rubric scoring (compatibility mode reproduces that).",
    "The rubric user query is the task instruction; the released upstream "
    "metadata has no instruction.txt, so upstream passes an empty query.",
    "Judge models are configurable (upstream example: gemini-2.5-flash).",
    "Unparseable judge replies are re-requested a bounded number of times "
    "(upstream: up to 10); a comparison still missing after retries fails the "
    "unit instead of averaging the remaining references.",
    "Candidate images are the report's validated relative image links; upstream "
    "silently drops links that do not resolve.",
]


def to_optional_float(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if math.isnan(value) else float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _strip_json_block(text):
    trimmed = text.strip()
    if not trimmed:
        return ""
    if trimmed.startswith("```"):
        parts = trimmed.split("\n", 1)
        body = parts[1] if len(parts) > 1 else ""
        end_split = body.rsplit("```", 1)
        body = end_split[0] if len(end_split) > 1 else body
        return body.strip()
    match = JSON_BLOCK_PATTERN.search(trimmed)
    if match:
        return match.group(1).strip()
    return trimmed


def parse_json_response(raw):
    if not raw:
        return None
    text = _strip_json_block(raw)
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        cleaned = re.sub(r":\s*\+(\d+(?:\.\d+)?)", r": \1", text)
        cleaned = re.sub(r"\\(?![\"\\/bfnrtu0-9])", r"\\\\", cleaned)
        try:
            return json.loads(cleaned)
        except Exception:
            return None


def _collect_scores(obj, acc):
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in TARGET_KEYS:
                acc.append(to_optional_float(value))
            _collect_scores(value, acc)
    elif isinstance(obj, list):
        for item in obj:
            _collect_scores(item, acc)


def extract_total_score(result):
    if not result:
        return None
    data = parse_json_response(result)
    if data is None:
        pattern = re.compile(
            r"[\"']?(?:总得分|总分|score|total_score)[\"']?\s*[:=：]\s*(-?\d+(?:\.\d+)?)"
        )
        for match in reversed(pattern.findall(result)):
            try:
                return float(match)
            except ValueError:
                continue
        return None
    scores = []
    _collect_scores(data, scores)
    for score in reversed(scores):
        if score is not None:
            return score
    return None


def valid_rubric(reply):
    """Upstream acceptance: a JSON object with an extractable total score."""
    return (
        isinstance(parse_json_response(reply), dict)
        and extract_total_score(reply) is not None
    )


def valid_gsb(reply):
    return isinstance(parse_json_response(reply), dict)


def normalize_dimension_name(raw):
    if not raw:
        return None
    text = str(raw).strip().lower()
    if not text:
        return None
    if "完备" in raw or "completeness" in text or "complete" in text:
        return "Completeness"
    if "精确" in raw or "准确" in raw or "accuracy" in text or "precis" in text:
        return "Accuracy"
    if "结论" in raw or "conclus" in text or "insight" in text:
        return "Conclusiveness"
    return None


def parse_rubric_dimension_scores(raw_text):
    scores = {label: 0.0 for label in DIMENSION_LABELS}
    if not raw_text or not isinstance(raw_text, str):
        return scores
    text = raw_text.strip()
    if not text:
        return scores
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]
    else:
        block = re.search(
            r"```json\s*(\{.*?\})\s*```", text, flags=re.DOTALL | re.IGNORECASE
        )
        if block:
            text = block.group(1)
    try:
        data = json.loads(text)
    except Exception:
        return scores

    def traverse(obj):
        if isinstance(obj, dict):
            dim = None
            for key in ("标准类型", "criterion_type", "type", "dimension"):
                if key in obj:
                    dim = normalize_dimension_name(obj.get(key))
                    if dim:
                        break
            if dim:
                value = None
                for key in ("得分", "score"):
                    if key in obj:
                        value = to_optional_float(obj.get(key))
                        if value is not None:
                            break
                if value is not None:
                    scores[dim] += value
            for child in obj.values():
                traverse(child)
        elif isinstance(obj, list):
            for item in obj:
                traverse(item)

    traverse(data)
    return scores


def _scan_pattern(keys, text):
    pattern = re.compile(
        "|".join(rf"{re.escape(key)}[^\d-]*(-?\d+(?:\.\d+)?)" for key in keys if key),
        flags=re.IGNORECASE,
    )
    for match in reversed(pattern.findall(text)):
        items = match if isinstance(match, tuple) else (match,)
        for item in reversed(items):
            if item:
                try:
                    return float(item)
                except ValueError:
                    continue
    return None


def extract_gsb_scores(result):
    text = result.strip()
    if not text:
        return {}
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]
    else:
        block = re.search(
            r"```json\s*(\{.*?\})\s*```", text, flags=re.DOTALL | re.IGNORECASE
        )
        if block:
            text = block.group(1)
    data = None
    try:
        candidate = json.loads(text)
        if isinstance(candidate, dict):
            data = candidate
    except Exception:
        cleaned = re.sub(r":\s*\+(\d+(?:\.\d+)?)", r": \1", text)
        cleaned = re.sub(r"\\(?![\"\\/bfnrtu0-9])", r"\\\\", cleaned)
        try:
            candidate = json.loads(cleaned)
            if isinstance(candidate, dict):
                data = candidate
        except Exception:
            pass

    def lookup_score(keys):
        if data:
            for key in keys:
                value = data.get(key)
                if isinstance(value, dict):
                    score = None
                    for field_key in GSB_SCORE_FIELDS:
                        if field_key in value:
                            score = to_optional_float(value.get(field_key))
                            if score is not None:
                                break
                    if score is not None:
                        return score
                else:
                    score = to_optional_float(value)
                    if score is not None:
                        return score
        fallback = _scan_pattern(keys, text)
        if fallback is not None:
            return fallback
        # Upstream treats a missing dimension as a strong loss (-10 maps to -1).
        return -10.0

    return {
        "readability": lookup_score(GSB_READABILITY_KEYS),
        "professionalism": lookup_score(GSB_PROFESSIONALISM_KEYS),
        "visualization": lookup_score(GSB_VISUALIZATION_KEYS),
    }


def trans_gsb_score(score_list):
    def score_map(raw):
        if raw < -3.0:
            return -1.0
        if raw <= 3.0:
            return 0.0
        return 1.0

    mapped = [score_map(float(v)) for v in score_list if v is not None]
    if not mapped:
        return None
    return max(0.0, sum(mapped) / len(mapped))


def _read(path):
    return Path(path).read_text(encoding="utf-8").strip()


def _resolve_images(markdown, base_dir):
    """Reference images: upstream tasks_loader rules, confined to base_dir."""
    images = []
    base = Path(base_dir).resolve()
    for match in IMAGE_PATTERN.findall(markdown):
        if "://" in match or match.startswith("/"):
            continue
        resolved = (base / match).resolve()
        if resolved.exists() and resolved.is_relative_to(base):
            images.append(str(resolved))
    return images


def references(instance_dir):
    """The five reference reports (first .md per gsb_ref_k) and their images."""
    refs = []
    for key in GSB_REF_KEYS:
        ref_dir = Path(instance_dir) / key
        md_files = sorted(ref_dir.glob("*.md")) if ref_dir.is_dir() else []
        if not md_files:
            continue
        text = _read(md_files[0])
        if text:
            refs.append(
                {"key": key, "text": text, "images": _resolve_images(text, ref_dir)}
            )
    return refs


def rubric_item(query, history, rubric):
    payload = json.dumps(
        [{"role": "assistant", "content": history}], ensure_ascii=False
    )
    text = RUBRIC_PROMPT_EN.format(
        user_query=query, assistant_response=payload, rubric=rubric
    )
    return [{"type": "text", "text": text}]


def gsb_item(template, report, report_images, reference, include_images):
    parts = [
        {
            "type": "text",
            "text": template.format(content1=report, content2=reference["text"]),
        }
    ]
    if include_images and report_images:
        parts.append({"type": "text", "text": "\n[被评测报告图片附件]"})
        parts.extend({"type": "image", "path": p} for p in report_images)
    if include_images and reference["images"]:
        parts.append({"type": "text", "text": "\n[参考报告图片附件]"})
        parts.extend({"type": "image", "path": p} for p in reference["images"])
    return parts


def prepare(request):
    """Builds every judge item for one unit from deliverables and evaluator files."""
    instance_dir = Path(request["instance_dir"])
    report = _read(request["report_path"])
    rubric = _read(instance_dir / "rubric.txt")
    refs = references(instance_dir)
    if len(refs) != len(GSB_REF_KEYS):
        raise ValueError("Expected five reference reports")
    items = [
        {
            "label": "rubric",
            "role": "rubric",
            "parts": rubric_item(request["query"], report, rubric),
        }
    ]
    for ref in refs:
        items.append(
            {
                "label": f"gsb_text:{ref['key']}",
                "role": "gsb_text",
                "parts": gsb_item(GSB_PROMPT_TEXT_EN, report, [], ref, False),
            }
        )
    # No candidate images: upstream assigns visualization 0 without asking a judge.
    if request["report_images"]:
        for ref in refs:
            items.append(
                {
                    "label": f"gsb_vision:{ref['key']}",
                    "role": "gsb_vision",
                    "parts": gsb_item(
                        GSB_PROMPT_VIS_EN, report, request["report_images"], ref, True
                    ),
                }
            )
    if request.get("trajectory_path"):
        trajectory = _read(request["trajectory_path"])
        items.append(
            {
                "label": "compat_rubric",
                "role": "rubric",
                "parts": rubric_item(request["query"], trajectory, rubric),
            }
        )
    return {"items": items}


def _maxima(instance_dir):
    meta = json.loads((Path(instance_dir) / "metadata.json").read_text("utf-8"))
    values = {
        key: int(meta[key])
        for key in ("Total", "Completeness", "Accuracy", "Conclusiveness")
    }
    if any(v <= 0 for v in values.values()):
        raise ValueError("Invalid rubric maxima")
    return values


def _rubric_metrics(reply, maxima):
    total = extract_total_score(reply)
    if total is None:
        raise ValueError("Rubric reply without total score")
    dims = parse_rubric_dimension_scores(reply)
    clip = lambda v: min(100.0, max(0.0, v))  # noqa: E731
    return {
        "rubric_percentage": clip(total / maxima["Total"] * 100.0),
        **{
            label.lower(): clip(dims[label] / maxima[label] * 100.0)
            for label in DIMENSION_LABELS
        },
    }


def _weighted(rubric_percentage, gsb):
    return (
        rubric_percentage * WEIGHTS["rubric"]
        + gsb["readability"] * 100.0 * WEIGHTS["readability"]
        + gsb["professionalism"] * 100.0 * WEIGHTS["professionalism"]
        + gsb["visualization"] * 100.0 * WEIGHTS["visualization"]
    ) / sum(WEIGHTS.values())


def combine(request):
    """Turns the unit's judge replies into DAComp metrics (upstream formulas)."""
    maxima = _maxima(request["instance_dir"])
    text = [extract_gsb_scores(r) for r in request["gsb_text"]]
    if request["gsb_vision"] is None:
        visualization = [0.0] * len(text)
    else:
        visualization = [
            extract_gsb_scores(r)["visualization"] for r in request["gsb_vision"]
        ]
    gsb = {
        "readability": trans_gsb_score([s["readability"] for s in text]),
        "professionalism": trans_gsb_score([s["professionalism"] for s in text]),
        "visualization": trans_gsb_score(visualization),
    }
    if any(v is None for v in gsb.values()):
        raise ValueError("Missing GSB comparisons")
    rubric = _rubric_metrics(request["rubric"], maxima)
    result = {
        "total": _weighted(rubric["rubric_percentage"], gsb),
        "rubric_ratio": rubric["rubric_percentage"] / 100.0,
        "completeness": rubric["completeness"],
        "accuracy": rubric["accuracy"],
        "conclusiveness": rubric["conclusiveness"],
        **gsb,
    }
    compat = None
    if request.get("compat_rubric") is not None:
        compat_rubric = _rubric_metrics(request["compat_rubric"], maxima)
        compat = {
            "total": _weighted(compat_rubric["rubric_percentage"], gsb),
            "rubric_ratio": compat_rubric["rubric_percentage"] / 100.0,
        }
    return {"metrics": result, "compat": compat}
