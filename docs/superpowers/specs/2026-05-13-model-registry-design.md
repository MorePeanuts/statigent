# Model Registry Design

## Goal

Provide a centralized, extensible model registry for the statigent data science agent. The registry loads model configurations from TOML files and returns ready-to-use langchain `BaseChatModel` instances via `init_chat_model`.

## TOML Config Format

Each named section is a profile. Only `model` is required; all other keys are passed as `**kwargs` to `init_chat_model`.

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

**API key handling:**
- If `api_key` is present and non-empty in TOML, pass it to `init_chat_model`
- If `api_key` is absent or empty in TOML, do not pass it — let `init_chat_model` and the provider package handle env var resolution automatically (e.g. `langchain-deepseek` reads `DEEPSEEK_API_KEY` by convention)
- If both TOML `api_key` and env var are missing, the provider will raise its own auth error, which we re-raise as `StatigentModelError`

## Module Structure

```
src/statigent/
├── __init__.py
└── models/
    ├── __init__.py       # Re-exports get_model, list_models, load_registry
    ├── defaults.toml     # Bundled defaults (deepseek-v4-flash variants)
    └── registry.py       # ModelRegistry class
```

## ModelRegistry API

```python
class ModelRegistry:
    @classmethod
    def load_registry(cls, path: str | Path | None = None) -> ModelRegistry:
        """Load model configs from a TOML file.

        If path is None, load bundled defaults.toml.
        """

    def get_model(self, name: str) -> BaseChatModel:
        """Return a BaseChatModel for the named profile."""

    def list_models(self) -> list[str]:
        """Return available profile names."""

    def has_model(self, name: str) -> bool:
        """Check if a profile exists."""
```

## Config Discovery

1. User provides a path -> load that file
2. No path provided -> load bundled `defaults.toml`
3. External `models.toml` **replaces** (does not merge with) bundled defaults

## Bundled Defaults

`src/statigent/models/defaults.toml` ships with the package and contains:

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

Users must set `DEEPSEEK_API_KEY` env var. Documented in README.

## Error Handling

Custom exception: `StatigentModelError(StatigentError)` for all registry errors.

| Failure mode | Behavior |
|---|---|
| Config file not found | `StatigentModelError` with file path and hint |
| TOML parse error | `StatigentModelError` with file path context |
| Unknown model name | `StatigentModelError` listing available models |
| `init_chat_model` fails | Re-raise as `StatigentModelError` via `raise ... from err` |
| Missing API key | `StatigentModelError` with provider-specific env var name |

## Testing

`tests/test_models_registry.py` mirrors `src/statigent/models/registry.py`.

| Test | What it verifies |
|---|---|
| `test_load_registry_from_file` | Load a temp TOML, verify `list_models` |
| `test_load_registry_defaults` | Load bundled defaults, verify `deepseek-v4-flash` profiles exist |
| `test_get_model_unknown_name_raises` | Unknown name -> `StatigentModelError` |
| `test_get_model_missing_config_file_raises` | Non-existent file -> `StatigentModelError` |
| `test_api_key_from_env` | Env var fallback when no `api_key` in TOML |
| `test_api_key_from_config` | TOML `api_key` takes precedence over env var |
| `test_invalid_toml_raises` | Malformed TOML -> `StatigentModelError` |

All tests mock `init_chat_model`; no real API calls.

## Dependencies

- `langchain-deepseek` (new, for DeepSeek provider support)
- `langchain` (already in pyproject.toml)
