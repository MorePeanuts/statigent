# Subagent Token Usage Backfill Design

## Goal

Add an offline tool that analyzes Statigent evaluation traces, records compact
per-subagent token summaries in `meta.json`, and writes detailed per-task token
sequences and cross-task invocation trends to `subagent_token_usage.json`.

## Interface

The tool accepts either one evaluation run directory or a parent directory:

```bash
uv run python tools/backfill_subagent_token_usage.py evaluations/example-run
uv run python tools/backfill_subagent_token_usage.py evaluations
```

Only runs with `agent_name="statigent"` and a `traces/` directory are updated.
Other agent runs are skipped.

## Meta Summary

`meta.json` receives a `subagent_token_usage` mapping keyed by trace event
`agent`. Events without integer `usage_metadata.input_tokens` and
`usage_metadata.output_tokens` are ignored.

Each subagent summary contains:

```json
{
  "invocations": 10,
  "input_tokens": 1000,
  "output_tokens": 200,
  "average_input_tokens": 100.0,
  "average_output_tokens": 20.0,
  "max_input_tokens": 180
}
```

## Detailed Usage File

`subagent_token_usage.json` contains:

- `tasks`: per-task sequences keyed by trace file path relative to `traces/`,
  without the `.jsonl` suffix;
- `trends`: cross-task invocation-round aggregates grouped by subagent and event
  name.

Example:

```json
{
  "tasks": {
    "523": {
      "inspector": {
        "plan": [1524, 3185],
        "final_draft": [3977]
      }
    }
  },
  "trends": {
    "inspector": {
      "plan": [
        {
          "round": 1,
          "samples": 1,
          "average_input_tokens": 1524.0,
          "max_input_tokens": 1524
        }
      ]
    }
  }
}
```

The Nth value in a task sequence is the Nth invocation of that subagent event
within that task. Trends aggregate the same invocation position across tasks.

## Error Handling

Malformed JSONL lines and events with missing or invalid usage metadata are
ignored. Existing unrelated `meta.json` fields are preserved. Existing detailed
usage files are replaced deterministically on each run.

## Testing

Tests cover:

- per-subagent summary aggregation;
- task sequence grouping by subagent and event name;
- round trend samples, averages, and maximums;
- nested task trace paths;
- malformed lines and invalid usage metadata;
- skipping non-Statigent runs.
