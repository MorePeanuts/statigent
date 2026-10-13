import pytest
from statigent_modeling.profile import summarize


def test_numeric_missing_and_parse_rules():
    result = summarize("x", ["", "1", "2e0", "3.0", "4"], "feature")
    assert result["type"] == "numeric"
    assert result["missing"] == 1
    assert result["quantiles"] == [1, 1.75, 2.5, 3.25, 4]
    mixed = summarize("x", ["NA", "NaN", "inf", "0x10", " ", "", "1"], "feature")
    assert mixed["type"] == "categorical"
    assert mixed["missing"] == 1
    assert mixed["numeric_parse_failures"] == 5
    assert mixed["quantiles"] is None


def test_raw_labels_and_category_truncation_are_explicit():
    labels = ["001", "1", "是,\r\n否"]
    result = summarize("target", labels, "target", categorical=True)
    assert result["type"] == "categorical"
    assert {x["value"] for x in result["categories"]} == set(labels)
    large = summarize("x", ["a" * 200] * 3 + [str(i) for i in range(20)], "feature")
    assert large["unique"] == 21
    assert large["omitted_categories"] == 11
    assert len(large["categories"]) == 10
    assert large["categories"][0] == {
        "value": "a" * 128,
        "count": 3,
        "omitted_characters": 72,
    }


@pytest.mark.parametrize("values", [["-1e308", "1e308"], ["1e308", "1e308"]])
def test_quantiles_do_not_overflow(values):
    result = summarize("x", values, "feature")
    assert result["quantiles"][2] in [0, 1e308]
