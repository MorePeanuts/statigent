# Code Execution Statistics Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tool that computes total executable code lines and code execution error rate from evaluation traces and writes them to `meta.json`.

**Architecture:** A standalone script follows the existing backfill tool pattern. Pure helpers parse trace events and calculate statistics, while a run-level helper discovers trace files and updates only the two new metadata fields.

**Tech Stack:** Python 3.12, standard library `argparse`, `json`, and `pathlib`; pytest; uv.

---

### Task 1: Implement and verify the backfill tool

**Files:**
- Create: `tools/backfill_code_execution_stats.py`
- Create: `tests/tools/test_backfill_code_execution_stats.py`

- [ ] **Step 1: Write failing tests for line counting and execution statistics**

Create tests that dynamically load the tool module and assert:

```python
assert count_code_lines("x = 1\n\n# comment\n  # indented\nprint(x) # inline") == 2
```

Create trace events containing three `append_code_cell` events and matched
observations with exit codes `0`, `1`, and missing. Assert the aggregate result
has the expected line count and error rate of `1 / 3`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
uv run pytest tests/tools/test_backfill_code_execution_stats.py -v
```

Expected: FAIL because `tools/backfill_code_execution_stats.py` does not exist.

- [ ] **Step 3: Implement pure trace statistics helpers**

Implement:

```python
def _count_code_lines(code: str) -> int: ...
def _trace_code_stats(path: Path) -> tuple[int, int, int]: ...
```

The trace helper returns `(total_code_lines, total_code_blocks,
error_code_blocks)`. It ignores malformed JSONL records, identifies code blocks
by coder `append_code_cell` events, and matches coder observations by
`metadata.cell_id`.

- [ ] **Step 4: Add failing tests for run-directory backfill**

Create a temporary run with nested trace files and an existing unrelated
`meta.json` field. Assert `_backfill_run` preserves the existing field and
writes:

```python
{
    "total_code_lines": expected_lines,
    "code_execution_error_rate": expected_errors / expected_blocks,
}
```

Also assert a run with no code blocks records a rate of `0.0`.

- [ ] **Step 5: Implement run discovery, metadata update, and CLI**

Follow `tools/backfill_average_steps.py` for `_find_run_dirs`, `_backfill_run`,
argument parsing, and the `updated=<n> skipped=<n>` summary. Recursively scan
`traces/**/*.jsonl`, preserve unrelated metadata fields, and write formatted
JSON ending with a newline.

- [ ] **Step 6: Run focused tests and quality checks**

Run:

```bash
uv run pytest tests/tools/test_backfill_code_execution_stats.py -v
uv run ruff check tools/backfill_code_execution_stats.py tests/tools/test_backfill_code_execution_stats.py
uv run mypy tools/backfill_code_execution_stats.py
```

Expected: all commands pass.

- [ ] **Step 7: Verify against a copied real evaluation directory**

Copy one `meta.json` and representative trace files into a temporary run
directory, execute the CLI, and confirm both fields are written without changing
the source evaluation directory.

- [ ] **Step 8: Commit**

```bash
git add tools/backfill_code_execution_stats.py tests/tools/test_backfill_code_execution_stats.py
git commit -m "feat: backfill code execution statistics"
```
