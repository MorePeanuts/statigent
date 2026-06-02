# Failure Analysis Checklist

Use this checklist when a Statigent benchmark failure needs a deeper pass.

## Evidence To Collect

- Evaluation run: `evaluations/<run>`.
- Score artifact: `evaluation/scores.json`.
- Metadata: `meta.json`, if present.
- Trace files: exact JSONL paths inspected.
- Task id, prompt, expected answer, predicted answer, and scorer correctness.
- Dataset paths from trace metadata.
- Final output renderer content and warnings.

## Trace Questions

- Did `task_brief_planner` classify the task correctly?
- Did `data_science_agent` coerce or override task type?
- Did `inspector` require enough evidence before authorizing code or final
  answer?
- Did `reviewer` catch unsupported assumptions, or did it approve after naming
  the risk?
- Did `coder` run code that exactly implements the benchmark instructions?
- Did `debugger` fix the real failure or only make code executable?
- Did `output_renderer` preserve required answer fields and formatting?
- Did any component confuse benchmark-specific conventions, such as answer
  labels, rounding, train/test split, random seed, or inclusion/exclusion of
  aggregate rows?

## Common Statigent Failure Patterns

- Data modeling tasks are coerced into data analysis and lose modeling-specific
  validation requirements.
- The agent removes summary or aggregate rows without explicit benchmark
  instruction.
- The reviewer flags ambiguity but still approves the final answer without a
  discriminating calculation.
- The final answer includes extra fields or misses required labels.
- The agent optimizes for plausible reasoning instead of reproducing the
  evaluator's deterministic protocol.
- The trace has enough evidence for a minimal local recomputation, but the agent
  does not run it.

## Improvement Bar

Treat a proposed change as ready only when it has:

- A repeated or high-impact failure pattern, not a single unexplained miss.
- A clear component boundary.
- A minimal behavior change that would have altered the trace.
- A test or benchmark slice that can falsify the hypothesis.
- No obvious regression against successful cases.
