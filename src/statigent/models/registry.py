from __future__ import annotations

import tomllib
from importlib.resources import files
from typing import TYPE_CHECKING, Any, cast

from langchain.chat_models import init_chat_model
from loguru import logger

from statigent.errors import StatigentModelError

if TYPE_CHECKING:
    from pathlib import Path

    from langchain_core.language_models import BaseChatModel


class ModelRegistry:
    """Registry of model configurations loaded from TOML files."""

    def __init__(self, profiles: dict[str, dict[str, object]]) -> None:
        self._profiles = profiles

    @classmethod
    def load_registry(cls, path: str | Path | None = None) -> ModelRegistry:
        """Load model configs from a TOML file.

        If path is None, load bundled defaults.toml.
        """
        if path is None:
            defaults_path = files("statigent.models") / "defaults.toml"
            return cls._load_from_path(str(defaults_path))
        return cls._load_from_path(str(path))

    @classmethod
    def _load_from_path(cls, path: str) -> ModelRegistry:
        try:
            with open(path, "rb") as f:
                data = tomllib.load(f)
        except FileNotFoundError:
            raise StatigentModelError(f"Model config file not found: {path}") from None
        except tomllib.TOMLDecodeError as e:
            raise StatigentModelError(
                f"Failed to parse TOML config at {path}: {e}"
            ) from e
        logger.debug("Loaded {} model profiles from {}", len(data), path)
        return cls(profiles=data)

    def get_model(self, name: str) -> BaseChatModel:
        """Return a BaseChatModel for the named profile."""
        if name not in self._profiles:
            available = ", ".join(self._profiles.keys()) or "(none)"
            raise StatigentModelError(f"Unknown model '{name}'. Available: {available}")
        kwargs: dict[str, Any] = dict(self._profiles[name])
        api_key = kwargs.pop("api_key", None)
        if api_key:
            kwargs["api_key"] = api_key
        try:
            return cast("BaseChatModel", init_chat_model(**kwargs))
        except Exception as e:
            raise StatigentModelError(
                f"Failed to initialize model '{name}': {e}"
            ) from e

    def list_models(self) -> list[str]:
        """Return available profile names."""
        return list(self._profiles.keys())

    def has_model(self, name: str) -> bool:
        """Check if a profile exists."""
        return name in self._profiles
