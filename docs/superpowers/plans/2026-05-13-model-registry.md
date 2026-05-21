# Model Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TOML-based model registry that loads model configs and returns ready-to-use langchain `BaseChatModel` instances via `init_chat_model`.

**Architecture:** `ModelRegistry` loads TOML config files (bundled defaults or user-provided), stores profiles as dicts, and uses `init_chat_model(**profile)` to create model instances. Custom `StatigentModelError` wraps all failures.

**Tech Stack:** Python 3.12, langchain `init_chat_model`, `tomllib` (stdlib), `langchain-deepseek`, pytest

---

### Task 1: Add langchain-deepseek dependency

**Files:**
- Modify: `pyproject.toml` (via `uv add`)

- [ ] **Step 1: Add the dependency**

Run: `uv add langchain-deepseek`

- [ ] **Step 2: Verify init_chat_model works with deepseek**

Run: `uv run python -c "from langchain.chat_models import init_chat_model; m = init_chat_model('deepseek-v4-flash', model_provider='deepseek'); print(type(m).__name__)"`
Expected: `ChatDeepSeek`

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "feat: add langchain-deepseek dependency"
```

---

### Task 2: Create StatigentError exception hierarchy

**Files:**
- Create: `src/statigent/errors.py`
- Test: `tests/test_errors.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_errors.py`:

```python
from statigent.errors import StatigentError, StatigentModelError


def test_statigent_error_is_exception():
    assert issubclass(StatigentError, Exception)


def test_statigent_model_error_is_statigent_error():
    assert issubclass(StatigentModelError, StatigentError)


def test_statigent_model_error_message():
    err = StatigentModelError('test message')
    assert str(err) == 'test message'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_errors.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.errors'`

- [ ] **Step 3: Write minimal implementation**

Create `src/statigent/errors.py`:

```python
class StatigentError(Exception):
    """Base exception for all statigent errors."""


class StatigentModelError(StatigentError):
    """Error raised by the model registry."""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_errors.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/statigent/errors.py tests/test_errors.py
git commit -m "feat: add StatigentError and StatigentModelError exceptions"
```

---

### Task 3: Create defaults.toml bundled config and models package

**Files:**
- Create: `src/statigent/models/__init__.py`
- Create: `src/statigent/models/defaults.toml`

- [ ] **Step 1: Create the models directory and defaults.toml**

Create `src/statigent/models/defaults.toml`:

```toml
[deepseek-v4-flash]
model = "deepseek-v4-flash"
model_provider = "deepseek"
extra_body = {thinking = {type = "disabled"}}

[deepseek-v4-flash-thinking]
model = "deepseek-v4-flash"
model_provider = "deepseek"
reasoning_effort = "high"
extra_body = {thinking = {type = "enabled"}}
```

- [ ] **Step 2: Create models package __init__.py**

Create `src/statigent/models/__init__.py`:

```python
from statigent.models.registry import ModelRegistry

__all__ = ['ModelRegistry']
```

Note: This will fail to import until `registry.py` exists in Task 4. That's fine.

- [ ] **Step 3: Verify defaults.toml is accessible as package data**

Run: `uv run python -c "from importlib.resources import files; p = files('statigent.models') / 'defaults.toml'; import tomllib; data = tomllib.loads(p.read_text()); print(list(data.keys()))"`
Expected: `['deepseek-v4-flash', 'deepseek-v4-flash-thinking']`

- [ ] **Step 4: Commit**

```bash
git add src/statigent/models/defaults.toml src/statigent/models/__init__.py
git commit -m "feat: add models package with bundled defaults TOML config"
```

---

### Task 4: Implement ModelRegistry.load_registry, list_models, has_model

**Files:**
- Create: `src/statigent/models/registry.py`
- Test: `tests/test_models_registry.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_models_registry.py`:

```python
from pathlib import Path

import pytest

from statigent.errors import StatigentModelError
from statigent.models.registry import ModelRegistry


def _write_toml(tmp_path: Path, content: str) -> Path:
    """Write content to a TOML file under tmp_path and return its path."""
    p = tmp_path / 'models.toml'
    p.write_text(content)
    return p


class TestLoadRegistry:
    def test_load_registry_from_file(self, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\n'
            'model = "deepseek-v4-flash"\n'
            'model_provider = "deepseek"\n',
        )
        registry = ModelRegistry.load_registry(config)
        assert registry.list_models() == ['my-model']

    def test_load_registry_defaults(self):
        registry = ModelRegistry.load_registry()
        models = registry.list_models()
        assert 'deepseek-v4-flash' in models
        assert 'deepseek-v4-flash-thinking' in models

    def test_load_registry_missing_config_file_raises(self, tmp_path: Path):
        with pytest.raises(StatigentModelError, match='not found'):
            ModelRegistry.load_registry(tmp_path / 'nonexistent.toml')

    def test_load_registry_invalid_toml_raises(self, tmp_path: Path):
        p = tmp_path / 'bad.toml'
        p.write_text('{{invalid toml')
        with pytest.raises(StatigentModelError, match='TOML'):
            ModelRegistry.load_registry(p)


class TestHasModel:
    def test_has_model_true(self, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        assert registry.has_model('my-model') is True

    def test_has_model_false(self, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        assert registry.has_model('other-model') is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_models_registry.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'statigent.models.registry'`

- [ ] **Step 3: Write minimal implementation**

Create `src/statigent/models/registry.py`:

```python
from __future__ import annotations

import tomllib
from importlib.resources import files
from pathlib import Path

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from loguru import logger

from statigent.errors import StatigentModelError


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
            defaults_path = files('statigent.models') / 'defaults.toml'
            return cls._load_from_path(str(defaults_path))
        return cls._load_from_path(str(path))

    @classmethod
    def _load_from_path(cls, path: str) -> ModelRegistry:
        try:
            with open(path, 'rb') as f:
                data = tomllib.load(f)
        except FileNotFoundError:
            raise StatigentModelError(
                f'Model config file not found: {path}'
            ) from None
        except tomllib.TOMLDecodeError as e:
            raise StatigentModelError(
                f'Failed to parse TOML config at {path}: {e}'
            ) from e
        logger.debug('Loaded {} model profiles from {}', len(data), path)
        return cls(profiles=data)

    def get_model(self, name: str) -> BaseChatModel:
        """Return a BaseChatModel for the named profile."""
        raise NotImplementedError

    def list_models(self) -> list[str]:
        """Return available profile names."""
        return list(self._profiles.keys())

    def has_model(self, name: str) -> bool:
        """Check if a profile exists."""
        return name in self._profiles
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_models_registry.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/statigent/models/registry.py tests/test_models_registry.py
git commit -m "feat: add ModelRegistry with load_registry and list_models"
```

---

### Task 5: Implement ModelRegistry.get_model

**Files:**
- Modify: `src/statigent/models/registry.py` (replace `get_model` method)
- Modify: `tests/test_models_registry.py` (append `TestGetModel` class)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_models_registry.py` (add the import at the top of the file alongside existing imports, and add the new class at the end):

Add to top-level imports:

```python
from unittest.mock import patch
```

Append new class at end of file:

```python
class TestGetModel:
    @patch('statigent.models.registry.init_chat_model')
    def test_get_model_returns_base_chat_model(self, mock_init, tmp_path: Path):
        mock_model = object()
        mock_init.return_value = mock_model
        config = _write_toml(
            tmp_path,
            '[my-model]\n'
            'model = "deepseek-v4-flash"\n'
            'model_provider = "deepseek"\n'
            'temperature = 0.5\n',
        )
        registry = ModelRegistry.load_registry(config)
        result = registry.get_model('my-model')
        assert result is mock_model
        mock_init.assert_called_once_with(
            model='deepseek-v4-flash',
            model_provider='deepseek',
            temperature=0.5,
        )

    @patch('statigent.models.registry.init_chat_model')
    def test_get_model_unknown_name_raises(self, mock_init, tmp_path: Path):
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        with pytest.raises(StatigentModelError, match='Unknown model'):
            registry.get_model('nonexistent')

    @patch('statigent.models.registry.init_chat_model')
    def test_get_model_init_failure_raises(self, mock_init, tmp_path: Path):
        mock_init.side_effect = ValueError('bad provider')
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "bad-model"\n',
        )
        registry = ModelRegistry.load_registry(config)
        with pytest.raises(StatigentModelError, match='Failed to initialize'):
            registry.get_model('my-model')

    @patch('statigent.models.registry.init_chat_model')
    def test_get_model_api_key_from_config(self, mock_init, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            '[my-model]\n'
            'model = "deepseek-v4-flash"\n'
            'api_key = "sk-test-123"\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model('my-model')
        mock_init.assert_called_once_with(
            model='deepseek-v4-flash',
            api_key='sk-test-123',
        )

    @patch('statigent.models.registry.init_chat_model')
    def test_get_model_api_key_empty_not_passed(self, mock_init, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            '[my-model]\n'
            'model = "deepseek-v4-flash"\n'
            'api_key = ""\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model('my-model')
        mock_init.assert_called_once_with(model='deepseek-v4-flash')

    @patch('statigent.models.registry.init_chat_model')
    def test_get_model_no_api_key_not_passed(self, mock_init, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            '[my-model]\nmodel = "deepseek-v4-flash"\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model('my-model')
        mock_init.assert_called_once_with(model='deepseek-v4-flash')

    @patch('statigent.models.registry.init_chat_model')
    def test_get_model_kwargs_forwarded(self, mock_init, tmp_path: Path):
        mock_init.return_value = object()
        config = _write_toml(
            tmp_path,
            '[deepseek-v4-flash-thinking]\n'
            'model = "deepseek-v4-flash"\n'
            'model_provider = "deepseek"\n'
            'reasoning_effort = "high"\n',
        )
        registry = ModelRegistry.load_registry(config)
        registry.get_model('deepseek-v4-flash-thinking')
        mock_init.assert_called_once_with(
            model='deepseek-v4-flash',
            model_provider='deepseek',
            reasoning_effort='high',
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_models_registry.py::TestGetModel -v`
Expected: FAIL with `NotImplementedError`

- [ ] **Step 3: Implement get_model**

Replace the `get_model` method in `src/statigent/models/registry.py` with:

```python
    def get_model(self, name: str) -> BaseChatModel:
        """Return a BaseChatModel for the named profile."""
        if name not in self._profiles:
            available = ', '.join(self._profiles.keys()) or '(none)'
            raise StatigentModelError(
                f"Unknown model '{name}'. Available: {available}"
            )
        kwargs = dict(self._profiles[name])  # type: ignore[arg-type]
        api_key = kwargs.pop('api_key', None)
        if api_key:
            kwargs['api_key'] = api_key
        try:
            return init_chat_model(**kwargs)  # type: ignore[arg-type]
        except Exception as e:
            raise StatigentModelError(
                f"Failed to initialize model '{name}': {e}"
            ) from e
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_models_registry.py -v`
Expected: All tests pass

- [ ] **Step 5: Run lint and type check**

Run: `uv run ruff check src tests && uv run ruff format src tests --check && uv run mypy src`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/statigent/models/registry.py tests/test_models_registry.py
git commit -m "feat: implement ModelRegistry.get_model with api_key handling"
```

---

### Task 6: Update package __init__.py with public API

**Files:**
- Modify: `src/statigent/__init__.py`
- Modify: `src/statigent/models/__init__.py`

- [ ] **Step 1: Update models/__init__.py with convenience functions**

Replace `src/statigent/models/__init__.py` with:

```python
from __future__ import annotations

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


__all__ = ['ModelRegistry', 'get_model', 'list_models', 'load_registry']
```

- [ ] **Step 2: Update top-level __init__.py**

Replace `src/statigent/__init__.py` with:

```python
"""A data science agent for automated analysis, feature engineering, model
building, and insight generation."""

from statigent.models import get_model, list_models, load_registry

__version__ = '0.1.0'

__all__ = ['get_model', 'list_models', 'load_registry']
```

- [ ] **Step 3: Run lint and type check**

Run: `uv run ruff check src && uv run ruff format src --check && uv run mypy src`
Expected: No errors

- [ ] **Step 4: Verify public API works**

Run: `uv run python -c "from statigent import get_model, list_models, load_registry; print('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add src/statigent/__init__.py src/statigent/models/__init__.py
git commit -m "feat: export model registry public API from package root"
```

---

### Task 7: Update README with DEEPSEEK_API_KEY instructions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README**

Read `README.md` to check existing content.

- [ ] **Step 2: Add DEEPSEEK_API_KEY setup instruction**

Add a section to README.md (after any existing setup content) noting that users must set the `DEEPSEEK_API_KEY` environment variable to use the default model profiles.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add DEEPSEEK_API_KEY setup instruction to README"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `uv run pytest -v`
Expected: All tests pass

- [ ] **Step 2: Run lint and type check**

Run: `uv run ruff check src tests && uv run ruff format src tests --check && uv run mypy src`
Expected: No errors

- [ ] **Step 3: Run coverage check**

Run: `uv run pytest --cov`
Expected: Coverage reported with no unexpected gaps
