from pathlib import Path
from unittest.mock import patch

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


class TestGetModel:
    @patch("statigent.models.registry.init_chat_model")
    def test_get_model_returns_base_chat_model(self, mock_init: patch, tmp_path: Path):
        mock_model = object()
        mock_init.return_value = mock_model
        config = _write_toml(
            tmp_path,
            "[my-model]\n"
            'model = "deepseek-v4-flash"\n'
            'model_provider = "deepseek"\n'
            "temperature = 0.5\n",
        )
        registry = ModelRegistry.load_registry(config)
        result = registry.get_model("my-model")
        assert result is mock_model
        mock_init.assert_called_once_with(
            model="deepseek-v4-flash",
            model_provider="deepseek",
            temperature=0.5,
        )

    @patch("statigent.models.registry.init_chat_model")
    def test_get_model_unknown_name_raises(self, mock_init: patch, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        with pytest.raises(StatigentModelError, match="Unknown model"):
            registry.get_model("nonexistent")

    @patch("statigent.models.registry.init_chat_model")
    def test_get_model_init_failure_raises(self, mock_init: patch, tmp_path: Path):
        mock_init.side_effect = ValueError("bad provider")
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "bad-model"\n',
        )
        registry = ModelRegistry.load_registry(config)
        with pytest.raises(StatigentModelError, match="Failed to initialize"):
            registry.get_model("my-model")

    @patch("statigent.models.registry.init_chat_model")
    def test_get_model_api_key_from_config(self, mock_init: patch, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\napi_key = "sk-test-123"\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model("my-model")
        mock_init.assert_called_once_with(
            model="deepseek-v4-flash",
            api_key="sk-test-123",
        )

    @patch("statigent.models.registry.init_chat_model")
    def test_get_model_api_key_empty_not_passed(self, mock_init: patch, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\napi_key = ""\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model("my-model")
        mock_init.assert_called_once_with(model="deepseek-v4-flash")

    @patch("statigent.models.registry.init_chat_model")
    def test_get_model_no_api_key_not_passed(self, mock_init: patch, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model("my-model")
        mock_init.assert_called_once_with(model="deepseek-v4-flash")

    @patch("statigent.models.registry.init_chat_model")
    def test_get_model_kwargs_forwarded(self, mock_init: patch, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            "[deepseek-v4-flash-thinking]\n"
            'model = "deepseek-v4-flash"\n'
            'model_provider = "deepseek"\n'
            'reasoning_effort = "high"\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model("deepseek-v4-flash-thinking")
        mock_init.assert_called_once_with(
            model="deepseek-v4-flash",
            model_provider="deepseek",
            reasoning_effort="high",
        )
