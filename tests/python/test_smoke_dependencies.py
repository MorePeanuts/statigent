from statigent_runtime.smoke_dependencies import witnesses


def test_cross_subtask_data_use_excludes_imports_and_shadowed_values():
    def cell(code, subtask, identity):
        return {"code": code, "subtask_id": subtask, "cell_id": identity}

    prefix = cell("import math\ndata = [1, 3]\nmean = sum(data)/len(data)", "a", "1")
    found = witnesses([prefix, cell("centered = [1 - mean, 3 - mean]", "b", "2")])
    assert found and all(w["name"] == "mean" for w in found)
    assert not witnesses([prefix, cell("mean = 0\nprint(mean)", "b", "2")])
    assert not witnesses([prefix, cell("print(mean)", "a", "2")])
    assert not witnesses([prefix, cell("print(math.pi)", "b", "2")])
    assert not witnesses([prefix, cell("print([mean for mean in range(3)])", "b", "2")])
