# Code Execution Statistics Backfill Design

## Goal

Add an offline tool that scans evaluation trace files and records code execution
statistics in each run's `meta.json`.

## Interface

The script accepts either one evaluation run directory or a parent directory
containing multiple runs:

```bash
uv run python tools/backfill_code_execution_stats.py evaluations/example-run
uv run python tools/backfill_code_execution_stats.py evaluations
```

It updates runs that contain both `meta.json` and a `traces/` directory, and
prints the number of updated and skipped runs.

## Statistics

An event is a code block when it has `agent="coder"` and
`name="append_code_cell"`.

`total_code_lines` is the sum of executable-source lines from each code block's
`metadata.code`. Blank lines and lines whose first non-whitespace character is
`#` are excluded. Inline comments remain part of the code line.

An observation is matched to a code block by `metadata.cell_id`. A code block is
an execution error when its matched coder observation has a non-zero integer
`metadata.exit_code`. Missing observations, missing exit codes, and non-integer
exit codes are not counted as execution errors.

`code_execution_error_rate` is:

```text
error code blocks / total code blocks
```

The rate is `0.0` when there are no code blocks.

## Error Handling

Malformed JSONL lines are ignored so one damaged event does not prevent
backfilling the run. Events with missing or unexpected fields are ignored for
the statistic they cannot support.

Existing `meta.json` fields are preserved. The tool adds or replaces only
`total_code_lines` and `code_execution_error_rate`.

## Testing

Unit tests will cover:

- executable line counting that excludes blank and pure-comment lines;
- successful, failed, and unmatched code blocks;
- zero-code-block runs;
- nested trace directories and malformed JSONL lines;
- preservation of unrelated `meta.json` fields.
