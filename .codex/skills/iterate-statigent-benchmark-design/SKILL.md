---
name: iterate-statigent-benchmark-design
description: Analyze Statigent benchmark evaluation results and traces to identify failure patterns, diagnose whether errors come from agent design defects, and propose validated design/code improvements. Use when given a Statigent benchmark scores.json, evaluation run directory, trace JSONL file, DABench/DSBench/MLE-Bench result, or a request to iterate Statigent based on benchmark performance.
---

# Iterate Statigent Benchmark Design

## Overview

Use benchmark results as an evidence source for improving Statigent's agent
design. Start from the evaluation artifact, inspect failing task traces, identify
the exact decision that caused the wrong answer, and only then propose a design
or code change.

For deeper checklists, read
`references/failure-analysis-checklist.md` when a failure needs more than a
single trace pass.

## Workflow

1. Locate the evaluation run.
   - If the user gives `evaluations/<run>/evaluation/scores.json`, set the run
     directory to `evaluations/<run>`.
   - Inspect `meta.json` when present to confirm benchmark, agent, model,
     timestamp, average steps, and completed tasks.
   - Read `scores.json` to identify failed or partially failed tasks before
     opening traces.

2. Select cases deliberately.
   - Prioritize incorrect questions, missing predictions, malformed outputs,
     warnings, and cases where several fields are partly correct.
   - Prefer a small representative sample first: one obvious failure, one
     partial failure, and one high-cost or long trace if step counts are visible.
   - Map DABench `details.per_question[].id` to
     `evaluations/<run>/traces/<id>.jsonl` when that file exists.
   - For DSBench-style nested traces, map the question id to the matching
     `traces/<task-id>/question<id>.jsonl` file.

3. Inspect each trace through the Statigent trace viewer.
   - Run `uv run tools/trace_statigent.py <trace-jsonl>` for a readable event
     path.
   - Add `--expand` when the important prompt, code, observation, or final
     output is truncated.
   - Add `--metadata` when file paths, generated code, cell ids, or structured
     observations matter.
   - Use `--agent inspector`, `--agent reviewer`, `--agent coder`,
     `--agent debugger`, or `--name append_code_cell` to narrow noisy traces.
   - If the pager makes output hard to capture, use
     `PAGER=cat uv run tools/trace_statigent.py <trace-jsonl> --expand`.

4. Reconstruct the failure path.
   - Record the user task, expected answer, predicted answer, and correctness
     fields from `scores.json`.
   - In the trace, find the first irreversible bad decision, not only the final
     wrong answer.
   - Check planner classification, inspector assumptions, reviewer approvals,
     coder code, execution observations, debugger repairs, final draft, and
     output renderer formatting.
   - Confirm whether the code output actually matches the score failure. If
     needed, rerun the minimal calculation locally using repository commands and
     the original dataset path from trace metadata.

5. Classify root cause.
   - Agent design defect: task type coercion, missing verification gate,
     reviewer rubber-stamping, incorrect prompt incentives, insufficient
     evidence requirements, tool/result parsing weakness, output formatting
     contract mismatch, bad fallback behavior, or brittle state handoff.
   - Implementation bug: Python code, benchmark adapter, evaluator, parser,
     trace capture, sandbox, or output renderer behavior contradicts the
     intended design.
   - Benchmark/evaluator issue: label ambiguity, evaluator tolerance mismatch,
     inconsistent expected preprocessing, or scoring artifact.
   - Model limitation: reasoning or coding failure despite adequate design
     constraints and available evidence. Do not use this category until design
     and implementation explanations have been ruled out.

6. Propose an improvement with a falsifiable hypothesis.
   - State the defect as: "In traces X/Y, component Z made decision D because
     prompt/state/check C was missing; adding/change P should prevent this
     class of failures."
   - Tie the proposal to Statigent source locations such as
     `src/statigent/agents/data_science.py`,
     `src/statigent/exploration/orchestrator.py`,
     `src/statigent/exploration/prompts.py`,
     `src/statigent/output/renderer.py`, or benchmark adapters under
     `src/statigent/benchmarks/`.
   - Prefer narrow, testable changes over broad prompt rewrites.
   - Include what metric or targeted tasks should improve after the change.

7. Validate before calling the iteration successful.
   - Add or update focused tests when code behavior changes.
   - Run targeted checks first, then relevant project checks:
     `uv run ruff check src tests`, `uv run mypy src`, and targeted
     `uv run pytest ...`.
   - If possible, rerun the affected benchmark task or the smallest benchmark
     slice that exercises the failing behavior.
   - Report remaining uncertainty explicitly if the full benchmark was not
     rerun.

## Output Shape

Return a concise engineering note:

- `Cases inspected`: scores path, trace files, and task ids.
- `Observed failure`: expected vs predicted result and first bad trace decision.
- `Root cause`: design defect, implementation bug, benchmark issue, or model
  limitation, with evidence.
- `Proposed change`: source files or prompts to update, and why.
- `Validation`: tests or benchmark slice to run, plus any checks already run.

## Guardrails

- Do not infer a design defect from `scores.json` alone; always inspect the
  trace or explain why it is unavailable.
- Do not assume every wrong answer needs a code change. Some failures are
  benchmark ambiguities or isolated model mistakes.
- Do not hide uncertainty. If the expected answer depends on ambiguous data
  preprocessing, say which assumptions differ and how to test them.
- Preserve existing project rules: use `uv`, keep Python typed, avoid manual
  dependency edits, and follow the repository's quality gates.
