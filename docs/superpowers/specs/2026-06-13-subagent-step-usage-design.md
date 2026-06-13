# Subagent Step Usage Design

## Goal

Remove the ambiguous `average_steps` metric and replace it with step statistics
that preserve Statigent's subagent boundaries. A step is one model invocation
with valid integer `input_tokens` and `output_tokens`.

## Output

`meta.json` receives a `subagent_step_usage` mapping keyed by agent name:

```json
{
  "subagent_step_usage": {
    "inspector": {
      "total_steps": 859,
      "active_tasks": 257,
      "average_steps_per_task": 3.3424,
      "average_steps_per_active_task": 3.3424
    }
  }
}
```

- `total_steps` counts valid model invocations for the subagent.
- `active_tasks` counts completed tasks where the subagent was invoked.
- `average_steps_per_task` divides by all completed tasks in the run.
- `average_steps_per_active_task` divides by tasks where the subagent was
  invoked.

Baseline agents are represented as a single agent and use the same definition.

## Compatibility

Remove `average_steps` and `total_steps` from generated and backfilled
`meta.json` files to prevent their trace-line-based definitions from being
misused. Keep `completed_tasks`, because it is required by the new metric and
remains unambiguous.

The existing `subagent_token_usage` mapping remains the source for separately
reported cumulative input and output tokens per subagent.

## Implementation

- Extend `tools/backfill_subagent_token_usage.py` to compute and write
  `subagent_step_usage`, and remove the obsolete keys.
- Update `RunPersister` to stop generating trace-line step metrics and remove
  obsolete keys when finalizing resumed runs.
- Update `tools/backfill_average_steps.py` into a compatibility wrapper that
  removes obsolete metrics rather than recreating them.
- Add focused tests for Statigent, baseline, fresh-run, and resumed-run
  behavior.
- Run the backfill across all evaluation directories.
