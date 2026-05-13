from langchain_core.language_models import BaseChatModel

from statigent.models.registry import ModelRegistry

_DEFAULT_REGISTRY: ModelRegistry | None = None


def get_model(name: str) -> BaseChatModel:
    """Get a model by name from the default registry."""
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = ModelRegistry.load_registry()
    return _DEFAULT_REGISTRY.get_model(name)


def list_models() -> list[str]:
    """List available model names from the default registry."""
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = ModelRegistry.load_registry()
    return _DEFAULT_REGISTRY.list_models()


def load_registry(path: str | None = None) -> ModelRegistry:
    """Load a model registry from a TOML file."""
    return ModelRegistry.load_registry(path)


__all__ = ["ModelRegistry", "get_model", "list_models", "load_registry"]
