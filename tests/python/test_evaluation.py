import pytest
from statigent_evaluation.bridge import handle
from statigent_evaluation.infiagent import is_equal, score, validate_answers


def test_numeric_and_string_semantics():
    assert is_equal("1.0", "1")
    assert not is_equal("0.000001", "0")
    assert is_equal("0.0000009", "0")
    assert not is_equal("ABC", "abc")
    assert not is_equal(" x ", "x")
    assert not is_equal(None, "0")


def test_field_extraction_and_denominator():
    labels = [["a", "1"], ["b", "2"]]
    assert score(labels, "@a[1]")["psaq"] == 0.5
    assert score(labels, "")["abq"] == 0
    assert score(labels, "@a[0] @a[1] @b[2]")["abq"] == 1
    assert score(labels, "@a[\n1] @b[2]")["psaq"] == 0.5


@pytest.mark.parametrize("labels", [[], [["a", "1"], ["a", "2"]], [["a", 1]], None])
def test_invalid_labels_are_not_wrong_answers(labels):
    with pytest.raises(ValueError):
        validate_answers(labels)


def test_bridge_identity_and_protocol():
    result = handle(
        {
            "schema_version": 1,
            "unit_id": "u",
            "answers": [["a", "1"]],
            "answer_text": "@a[1]",
        }
    )
    assert result["unit_id"] == "u"
    assert result["status"] == "scored"
    with pytest.raises(ValueError):
        handle({"schema_version": 2})
