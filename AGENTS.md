# Statigent Agent Instructions

## Project Context

Statigent is a Python data science agent for automated analysis, feature
engineering, model building, and insight generation.

Use these instructions as the agent-facing companion to `CLAUDE.md`. If the
agent docs and tool configuration disagree, prefer the concrete configuration in
`pyproject.toml`, then update the docs to remove the mismatch.

## Tech Stack

- Python 3.12+, managed by `uv`
- Package/build tooling: `uv`, `uv_build`
- Agent stack: `langchain`, `langgraph`, `deepagents`
- CLI/output: `typer`, `rich`
- Logging: `loguru`
- HTTP: `httpx[socks]`
- Quality gates: `ruff`, `mypy --strict`, `pytest`, `pytest-cov`

## Common Commands

```bash
uv sync
uv run python -m statigent
uv run ruff check src tests
uv run ruff format src tests
uv run mypy src
uv run pytest
uv run pytest -m "not slow"
uv run pytest --cov
uv build
```

Add dependencies with `uv add` only:

```bash
uv add <package>
uv add --dev <package>
```

Do not manually edit dependency lists in `pyproject.toml` unless the task is
specifically about project metadata.

## Coding Standards

- Keep Python code typed. All function signatures need complete annotations.
- Prefer concrete types; avoid `Any` unless it is genuinely unavoidable.
- Use modern Python syntax: `X | Y`, `list[X]`, `dict[str, X]`.
- Do not add `from __future__ import annotations`; Python 3.12+ is required.
- Use `pydantic` models at system boundaries.
- Use `typing.Protocol` for interfaces and `typing.override` for overrides.
- Use custom exceptions under the `StatigentError` hierarchy.
- Catch specific exceptions only; never use bare `except:`.
- Preserve exception chains with `raise ... from err`.
- Use `loguru` for diagnostics and `rich` for user-facing terminal output.
- Do not use `print()` for diagnostic output.

- Comments explain WHY, not WHAT — omit comments that restate the code or reference task/PR context. Public functions and classes must have docstrings; private helpers only need them when the purpose isn't obvious from the signature.
- Formatting is controlled by `pyproject.toml`; follow the formatter.

## Tests

- Tests live under `tests/`, mirroring `src/statigent/` where practical.
- Use plain pytest functions or classes; do not use `unittest.TestCase`.
- Name tests as `test_<what>_<condition>_<expected>`.
- Use `pytest.fixture` for setup; prefer factory fixtures over module state.
- Mark slow tests with `pytest.mark.slow`.
- Mark integration tests with `pytest.mark.integration`.

Run targeted tests while developing, then the relevant full checks before
finishing. For broad code changes, run:

```bash
uv run ruff check src tests
uv run mypy src
uv run pytest
```

## Repository Layout

```text
src/statigent/          main package
tests/                 test suite
docs/                  project documentation and plans
benchmarks/            benchmark integrations and subprojects
config/models.toml     local model configuration
src/statigent/models/defaults.toml
```

## Git Workflow

The repository follows Git Flow:

- Long-lived branches: `main` and `develop`
- Feature branches branch from `develop` and merge back into `develop`
- Release branches branch from `develop`, then merge into `main` and `develop`
- Hotfix branches branch from `main`, then merge into `main` and `develop`
- Use `--no-ff` when merging into main branches
- Tag every merge into `main`
- Use conventional commit messages: `feat:`, `fix:`, `refactor:`, `test:`,
  `docs:`, `chore:`

## Local Environment Notes

The sandbox may block direct access to the user-level `uv` cache. If a needed
`uv run ...` command fails with a permission error against
`~/.cache/uv/sdists-v9/.git`, rerun the same command with escalated permission.
