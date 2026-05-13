from pathlib import Path

import pytest

from statigent.errors import StatigentModelError
from statigent.models.registry import ModelRegistry


def _write_toml(tmp_path: Path, content: str) -> Path:
    """Write content to a TOML file under tmp_path and return its path."""
    p = tmp_path / "models.toml"
    p.write_text(content)
    return p


class TestLoadRegistry:
    def test_load_registry_from_file(self, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\nmodel_provider = "deepseek"\n',
        )
        registry = ModelRegistry.load_registry(config)
        assert registry.list_models() == ["my-model"]

    def test_load_registry_defaults(self):
        registry = ModelRegistry.load_registry()
        models = registry.list_models()
        assert "deepseek-v4-flash" in models
        assert "deepseek-v4-flash-thinking" in models

    def test_load_registry_missing_config_file_raises(self, tmp_path: Path):
        with pytest.raises(StatigentModelError, match="not found"):
            ModelRegistry.load_registry(tmp_path / "nonexistent.toml")

    def test_load_registry_invalid_toml_raises(self, tmp_path: Path):
        p = tmp_path / "bad.toml"
        p.write_text("{{invalid toml")
        with pytest.raises(StatigentModelError, match="TOML"):
            ModelRegistry.load_registry(p)


class TestHasModel:
    def test_has_model_true(self, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        assert registry.has_model("my-model") is True

    def test_has_model_false(self, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        assert registry.has_model("other-model") is False
