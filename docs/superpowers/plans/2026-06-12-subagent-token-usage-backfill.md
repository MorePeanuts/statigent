# Subagent Token Usage Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tool that writes Statigent per-subagent token summaries and detailed per-task input-token trends.

**Architecture:** Parse each trace independently into subagent/event input-token sequences and usage totals. Merge task sequences into deterministic round trends, update `meta.json`, and write a separate detailed JSON artifact.

**Tech Stack:** Python 3.12 standard library, pytest, uv.

---

### Task 1: Implement token usage backfill

**Files:**
- Create: `tools/backfill_subagent_token_usage.py`
- Create: `tests/tools/test_backfill_subagent_token_usage.py`

- [ ] Write failing tests for summary aggregation, task sequences, trends, malformed records, nested trace paths, and non-Statigent runs.
- [ ] Run `uv run pytest tests/tools/test_backfill_subagent_token_usage.py -v` and verify failures are caused by the missing tool.
- [ ] Implement trace parsing, aggregation, run discovery, metadata update, detailed file writing, and CLI.
- [ ] Run focused tests, `ruff`, and `mypy`.
- [ ] Run the tool on temporary copies of real Statigent runs and inspect output.
- [ ] Run full project verification.
- [ ] Commit with `feat: backfill subagent token usage`.
