# Subagent Step Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ambiguous trace-line step metrics and record comparable model-invocation step statistics for each agent.

**Architecture:** `RunPersister` will retain only the unambiguous completed-task count and remove obsolete step keys during finalization. The existing subagent token backfill tool will derive both token and step summaries from the same validated model-invocation events, keeping both metrics aligned.

**Tech Stack:** Python 3.12, JSONL traces, pytest, ruff, mypy

---

### Task 1: Remove Trace-Line Step Metrics From Runtime Persistence

**Files:**
- Modify: `src/statigent/benchmarks/base.py`
- Modify: `tests/benchmarks/test_persistence.py`

- [ ] **Step 1: Write failing persistence tests**

Replace assertions for `total_steps` and `average_steps` with assertions that
fresh and resumed finalization omit both keys while preserving
`completed_tasks`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `uv run pytest tests/benchmarks/test_persistence.py -k "steps or completed_tasks" -v`

Expected: FAIL because `RunPersister.finalize()` still writes the obsolete keys.

- [ ] **Step 3: Remove obsolete runtime counters**

Delete `_count_trace_file_steps`, remove `_total_steps`, scan only the number of
trace files when finalization has no in-memory completed-task count, and
`pop("total_steps")` plus `pop("average_steps")` before writing `meta.json`.

- [ ] **Step 4: Run focused tests**

Run: `uv run pytest tests/benchmarks/test_persistence.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/statigent/benchmarks/base.py tests/benchmarks/test_persistence.py
git commit -m "fix: remove ambiguous average step metrics"
```

### Task 2: Backfill Per-Agent Step Usage

**Files:**
- Modify: `tools/backfill_subagent_token_usage.py`
- Modify: `tools/backfill_average_steps.py`
- Modify: `tests/tools/test_backfill_subagent_token_usage.py`
- Create: `tests/tools/test_backfill_average_steps.py`

- [ ] **Step 1: Write failing tool tests**

Assert that the token usage backfill writes `subagent_step_usage` with
`total_steps`, `active_tasks`, `average_steps_per_task`, and
`average_steps_per_active_task`; also assert it removes `total_steps` and
`average_steps`. Assert that the compatibility cleanup tool removes obsolete
keys without adding replacements.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `uv run pytest tests/tools/test_backfill_subagent_token_usage.py tests/tools/test_backfill_average_steps.py -v`

Expected: FAIL because no per-agent step summary exists and the old tool still
recreates obsolete metrics.

- [ ] **Step 3: Implement step summary and cleanup**

Derive per-agent steps from the validated usage events already used for token
summaries. Count active tasks from task sequences, divide by all trace tasks and
active tasks, write `subagent_step_usage`, and remove obsolete keys. Convert
`backfill_average_steps.py` to an obsolete-key cleanup utility.

- [ ] **Step 4: Run focused and full checks**

Run:

```bash
uv run pytest tests/tools/test_backfill_subagent_token_usage.py tests/tools/test_backfill_average_steps.py -v
uv run ruff check src tests tools
uv run mypy src tools/backfill_subagent_token_usage.py tools/backfill_average_steps.py
uv run pytest
```

Expected: all checks PASS.

- [ ] **Step 5: Backfill all evaluation directories**

Run:

```bash
uv run python tools/backfill_subagent_token_usage.py evaluations
uv run python tools/backfill_average_steps.py evaluations
```

Verify no `meta.json` contains `average_steps` or `total_steps`, and supported
runs contain `subagent_step_usage`.

- [ ] **Step 6: Commit**

```bash
git add tools/backfill_subagent_token_usage.py tools/backfill_average_steps.py tests/tools/test_backfill_subagent_token_usage.py tests/tools/test_backfill_average_steps.py
git commit -m "feat: backfill per-agent step usage"
```
