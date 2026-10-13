import json
from pathlib import Path

import pytest
from statigent_modeling.protocol import validate_protocol
from statigent_modeling.protocol_v2 import (
    create_protocol_v2,
    prediction_columns_v2,
    validate_protocol_v2,
)

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[1] / "fixtures/modeling-protocol-v2.json"
    ).read_text()
)


@pytest.mark.parametrize("fixture", FIXTURES["valid"])
def test_shared_protocol_fixtures(fixture):
    assert create_protocol_v2(fixture["input"]) == fixture["protocol"]
    protocol = validate_protocol_v2(fixture["protocol"], "id")
    columns = prediction_columns_v2(protocol)
    assert len(columns) == len(set(columns))
    if protocol["output"] == "ranked-labels":
        assert prediction_columns_v2(protocol, False) == ["id", "ranked_0"]


@pytest.mark.parametrize("fixture", FIXTURES["invalid_inputs"])
def test_shared_invalid_inputs(fixture):
    with pytest.raises(ValueError):
        create_protocol_v2(fixture["input"])


@pytest.mark.parametrize("fixture", FIXTURES["invalid_protocols"])
def test_shared_invalid_protocols(fixture):
    with pytest.raises(ValueError):
        validate_protocol_v2(fixture["protocol"])


def test_legacy_and_wrong_identity():
    assert validate_protocol(FIXTURES["legacy_v1"], "id") == FIXTURES["legacy_v1"]
    with pytest.raises(ValueError):
        validate_protocol_v2(FIXTURES["legacy_v1"])
    with pytest.raises(ValueError):
        validate_protocol_v2(FIXTURES["valid"][0]["protocol"], "wrong-id")
