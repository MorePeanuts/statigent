"""V2 与 TypeScript 共用指标目录；旧 v1 的序列化及数值语义不迁移。"""

import hashlib
import json
from pathlib import Path

DEFINITIONS = json.loads(
    Path(__file__).with_name("metric_definitions.json").read_text()
)["definitions"]


def canonical_json(value):
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names):
        raise ValueError("Invalid protocol fields")


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Invalid protocol string")
    return value


def unique(value, nonempty=False):
    if not isinstance(value, list):
        raise ValueError("Invalid protocol list")
    result = [text(v) for v in value]
    if (nonempty and not result) or len(result) != len(set(result)):
        raise ValueError("Empty/duplicate protocol list")
    return result


def metric_definition(identity):
    for definition in DEFINITIONS:
        if definition["id"] == identity:
            return {**definition, "definition_sha256": digest(definition)}
    raise ValueError("Unknown metric definition")


def create_protocol_v2(value):
    fields(value, ["kind", "metric_id", "targets", "id_column", "feature_columns"])
    kind = value["kind"]
    if kind not in ("regression", "binary", "multiclass", "ordinal", "multilabel"):
        raise ValueError("Invalid task kind")
    metric = metric_definition(value["metric_id"])
    if kind not in metric["kinds"]:
        raise ValueError("Unsupported task/metric combination")
    identity = text(value["id_column"])
    features = unique(value["feature_columns"], True)
    raw_targets = value["targets"]
    if not isinstance(raw_targets, list) or (
        len(raw_targets) < 2 if kind == "multilabel" else len(raw_targets) != 1
    ):
        raise ValueError("Invalid targets")
    targets = []
    for raw in raw_targets:
        fields(raw, ["name", "classes", "positive_class", "levels"])
        name = text(raw["name"])
        classes = unique(raw["classes"], kind != "regression")
        if (
            (kind == "regression" and classes)
            or (kind in ("binary", "multilabel") and len(classes) != 2)
            or (kind in ("multiclass", "ordinal") and len(classes) < 3)
        ):
            raise ValueError("Invalid target class count")
        positive = raw["positive_class"]
        if kind in ("binary", "multilabel"):
            if not isinstance(positive, str) or positive not in classes:
                raise ValueError("Invalid positive class")
        elif positive is not None:
            raise ValueError("Unexpected positive class")
        levels = raw["levels"]
        if kind == "ordinal":
            if (
                not isinstance(levels, list)
                or len(levels) != len(classes)
                or any(type(v) is not int or not 0 <= v < 10 for v in levels)
                or len(set(levels)) != len(levels)
            ):
                raise ValueError("Invalid ordinal coordinates")
        elif levels is not None:
            raise ValueError("Unexpected ordinal coordinates")
        targets.append(
            {
                "name": name,
                "classes": classes,
                "positive_class": positive,
                "levels": levels,
            }
        )
    names = [t["name"] for t in targets]
    if (
        len(names) != len(set(names))
        or identity in names
        or set(features) & {identity, *names}
    ):
        raise ValueError("Feature/target/identity overlap")
    used = {identity, *features, *names}

    def column(base):
        while base in used:
            base += "_"
        used.add(base)
        return base

    output = metric["output"]
    prediction_targets = []
    for index, target in enumerate(targets):
        prediction_targets.append(
            {
                "target": target["name"],
                "value_column": None
                if output == "ranked-labels"
                else column(f"prediction_{index}"),
                "probability_columns": [
                    column(f"probability_{index}_{c}")
                    for c in range(len(target["classes"]))
                ]
                if output
                in ("probabilities", "multilabel-probabilities", "ranked-labels")
                else [],
                "ranked_column": column(f"ranked_{index}")
                if output == "ranked-labels"
                else None,
            }
        )
    content = {
        "version": 2,
        "kind": kind,
        "id_column": identity,
        "feature_columns": features,
        "targets": targets,
        "metric": metric,
        "output": output,
        "prediction": {
            "targets": prediction_targets,
            "probabilities_optional": output == "ranked-labels",
            "probability_tolerance": "1e-6",
            "ties": "frozen-class-order",
        },
        "scoring_version": "tabular-metrics-v2",
    }
    return {**content, "protocol_sha256": digest(content)}


def validate_protocol_v2(value, id_column=None):
    fields(
        value,
        [
            "version",
            "kind",
            "id_column",
            "feature_columns",
            "targets",
            "metric",
            "output",
            "prediction",
            "scoring_version",
            "protocol_sha256",
        ],
    )
    if (
        type(value["version"]) is not int
        or value["version"] != 2
        or (id_column is not None and value["id_column"] != id_column)
    ):
        raise ValueError("Invalid protocol version/identity")
    metric = value["metric"]
    if not isinstance(metric, dict):
        raise ValueError("Invalid metric definition")
    expected = create_protocol_v2(
        {
            "kind": value["kind"],
            "metric_id": metric.get("id"),
            "targets": value["targets"],
            "id_column": value["id_column"],
            "feature_columns": value["feature_columns"],
        }
    )
    if canonical_json(value) != canonical_json(expected):
        raise ValueError("Protocol identity/parameters mismatch")
    return expected


def prediction_columns_v2(protocol, include_optional=True):
    columns = [protocol["id_column"]]
    for target in protocol["prediction"]["targets"]:
        if target["value_column"] is not None:
            columns.append(target["value_column"])
        if target["ranked_column"] is not None:
            columns.append(target["ranked_column"])
        if include_optional or not protocol["prediction"]["probabilities_optional"]:
            columns.extend(target["probability_columns"])
    return columns
