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

The tool automatically recognizes the trace schema and extracts code blocks and
their execution results:

- Statigent: coder `append_code_cell` events matched to coder observations by
  `metadata.cell_id`; a non-zero integer `metadata.exit_code` is an error.
- Datawise: Python fenced blocks in assistant messages matched in order to
  `role="tool", name="python"` results; output beginning with a non-zero
  `Exit code:` is an error.
- Data Interpreter: Python fenced blocks in `write_code` and `reflect_code`
  events matched in order to `execute_code` events; `metadata.success == false`
  is an error.
- ReAct: `python` and `bash` tool calls matched to tool results by tool call ID;
  output beginning with a non-zero `Exit code:` is an error.

`total_code_lines` is the sum of executable-source lines from all extracted code
blocks. Blank lines and lines whose first non-whitespace character is `#` are
excluded. Inline comments remain part of the code line.

Missing execution results and results without a recognized failure signal are
not counted as execution errors.

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
- Statigent, Datawise, Data Interpreter, and ReAct trace schemas;
- ReAct Python and Bash tool calls;
- zero-code-block runs;
- nested trace directories and malformed JSONL lines;
- preservation of unrelated `meta.json` fields.
