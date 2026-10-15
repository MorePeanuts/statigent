import json
import sys
import types

import pytest
from statigent_baselines import autogluon_model
from test_modeling_dataset_v3 import prepare


@pytest.mark.parametrize("failure", [None, "second", "deadline"])
def test_shared_target_allowance_and_no_partial_multi_target_delivery(
    tmp_path, monkeypatch, failure
):
    source = tmp_path / "data"
    prepare(source)
    clock = [0.0]
    calls = []

    class Predictor:
        def __init__(self, **kwargs):
            self.options = kwargs
            self.model_best = "fitted"

        def fit(self, data, **parameters):
            calls.append((self.options, list(data.columns), parameters))
            if failure == "second" and len(calls) == 2:
                raise RuntimeError("second target failed")
            clock[0] += 101 if failure == "deadline" else 10

        def model_names(self):
            return ["fitted"]

        def save_space(self, **kwargs):
            assert kwargs == {"remove_data": True, "remove_fit_stack": True}

    module = types.ModuleType("autogluon.tabular")
    module.TabularPredictor = Predictor
    monkeypatch.setitem(sys.modules, "autogluon.tabular", module)
    monkeypatch.setattr(autogluon_model.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(autogluon_model, "scorer", lambda *_: "fixture")
    monkeypatch.setattr(autogluon_model, "expanded_fit_parameters", lambda p: p)
    destination = tmp_path / "bundle"
    if failure:
        with pytest.raises((RuntimeError, TimeoutError)):
            autogluon_model.train(source / "dataset.json", destination, 100, 2, 17)
        assert not (destination / "predict.py").exists()
        assert not json.loads((destination / "training.json").read_text())["complete"]
    else:
        result = autogluon_model.train(source / "dataset.json", destination, 100, 2, 17)
        assert result["elapsed_seconds"] == 20
        assert [t["allowance_seconds"] for t in result["targets"]] == [50, 90]
        assert [t["fit_time_limit_seconds"] for t in result["targets"]] == [40, 80]
        assert result["model_calls"] == 0
        assert (destination / "predict.py").exists()
    for index, (options, columns, _) in enumerate(calls):
        assert options["learner_kwargs"] == {
            "random_state": 17 + index,
            "cache_data": False,
        }
        assert columns == ["signal", "token", "EC1" if index == 0 else "EC2"]
