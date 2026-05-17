# Statigent - Data Science Agent

## Project Overview

A data science agent for automated analysis, feature engineering, model building, and insight generation.

## Tech Stack

- **Runtime**: Python 3.12+ (managed by uv)
- **Package Manager**: uv
- **Agent Framework**: langchain + langgraph + deepagents
- **HTTP Client**: httpx[socks]
- **Logging**: loguru
- **CLI Framework**: typer
- **Terminal Output**: rich
- **Testing**: pytest + pytest-cov
- **Linting/Formatting**: ruff
- **Type Checking**: mypy (strict mode)
- **Build System**: uv_build

## Project Structure

```
statigent/
├── src/
│   └── statigent/       # Main package
│       └── __init__.py
├── tests/                # Test directory (no __init__.py)
├── pyproject.toml
├── README.md
├── CLAUDE.md
└── .python-version
```

## Development Commands

```bash
# Add dependencies (always use uv add)
uv add <package>              # Runtime dependency
uv add --dev <package>        # Dev dependency

# Run
uv run python -m statigent

# Lint & Format
uv run ruff check src tests   # Lint
uv run ruff format src tests  # Format

# Type Check
uv run mypy src

# Test
uv run pytest
uv run pytest -m "not slow"   # Skip slow tests
uv run pytest --cov           # With coverage

# Build
uv build
```

## Coding Standards

### General Rules

- All Python code must pass `ruff check` and `ruff format` without errors
- All Python code must pass `mypy` strict mode type checking
- Prefer `uv run` over activating venv manually
- Use `uv add` to add dependencies — never manually edit dependencies in pyproject.toml

### Code Style

- Line length: 88 characters (ruff default)
- Use double quotes for strings
- Use spaces for indentation (4 spaces)
- Use `from __future__ import annotations` is NOT needed (Python 3.12+)
- Use modern Python syntax: `X | Y` instead of `Union[X, Y]`, `list[X]` instead of `List[X]`, etc.
- Import order (enforced by ruff isort): stdlib → third-party → first-party (`statigent`)

### Type Hints

- All function signatures must have complete type annotations
- Use `pydantic` models for data validation at system boundaries
- Use `typing.Protocol` for interface definitions
- Use `typing.override` for method overrides
- Prefer concrete types over `Any`; avoid `Any` unless truly unavoidable
- Use `NoReturn` for functions that never return

### Logging

- Use `loguru` for all logging — never use `print()` for diagnostic output
- Use `rich` for user-facing terminal output only
- Logger configuration should be centralized in the package entry point

### Error Handling

- Use custom exception hierarchies (inherit from a base `StatigentError`)
- Never use bare `except:` — always catch specific exceptions
- Use `raise ... from err` to preserve exception chains
- Validate inputs at system boundaries; trust internal code

### Testing

- Test files go in `tests/`, mirroring `src/statigent/` structure
- Test function names: `test_<what>_<condition>_<expected>`
- Use `pytest.mark.slow` for slow tests, `pytest.mark.integration` for integration tests
- Use `pytest.fixture` for shared setup; prefer factory fixtures over module-level state
- Test type: `unittest.TestCase` is forbidden — use plain pytest functions

### Git Workflow (Git Flow)

Follow [nvie's Git Branching Model](https://nvie.com/posts/a-successful-git-branching-model/):

**Main branches** (long-lived):
- `main` — always reflects production-ready state
- `develop` — always reflects the latest development changes for the next release

**Feature branches**:
- Branch off from: `develop`
- Merge back into: `develop` with `--no-ff`
- Naming: descriptive name (e.g. `feature/add-csv-loader`)

**Release branches**:
- Branch off from: `develop`
- Merge back into: `main` AND `develop` with `--no-ff`
- Naming: `release-*` (e.g. `release-0.2.0`)
- Only bug fixes and version bumps allowed — no new features

**Hotfix branches**:
- Branch off from: `main` (at the production tag)
- Merge back into: `main` AND `develop` with `--no-ff`
- Naming: `hotfix-*` (e.g. `hotfix-0.1.1`)
- If a release branch currently exists, merge hotfix into that release branch instead of `develop`

**General rules**:
- Always use `--no-ff` when merging into main branches to preserve history
- Tag every merge into `main` (e.g. `git tag -a v0.1.0`)
- Delete supporting branches after merging
- Commit messages: use conventional commits format (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`)

