# Data Exploration LangGraph Redesign

## Purpose

This design upgrades the current data science agent skeleton into a clearer
architecture for data analysis tasks. It addresses review feedback on the
input layer contract, task budgets, trace events, and the data exploration
orchestrator.

The implementation will keep layers decoupled:

- The input layer produces a validated task brief.
- The data exploration layer runs as a LangGraph state graph.
- The output layer renders exploration results for benchmarks and users.
- The future modeling layer receives structured EDA handoff reports, but its
  internal search or MCTS design is outside this scope.

## Scope

In scope:

- Refine `TaskBriefPlanner` around LangChain `BaseChatModel`.
- Make structured output parsing failures explicit errors.
- Convert budget selection from model-generated numbers to fixed tiers.
- Rewrite schema descriptions so they guide the LLM.
- Add `agent` and `session` trace metadata.
- Force `run_analysis_for_eval()` back to `data_analysis` when classification
  is wrong for that entrypoint.
- Redesign `ExplorationOrchestrator` as a LangGraph state graph.
- Make Inspector planning text-based, with a lightweight action block.
- Make Reviewer structured output the authoritative action approval and code
  instruction boundary.
- Add notebook cell append, replace, execute, and code-context operations.
- Add task-local debugger lessons.
- Treat prompts as first-class contracts.

Out of scope:

- Implementing the data modeling layer internals.
- Implementing deep commercial analysis.
- Adding project-wide or cross-run debugger memory.
- Replacing the existing benchmark adapter layer.

## Cross-Layer Contracts

### TaskBriefPlanner

`TaskBriefPlanner` should accept LangChain's `BaseChatModel` directly instead
of casting the model to an internal `_TaskBriefModel` protocol. The planner can
call:

```python
model.with_structured_output(TaskBrief, include_raw=True)
```

The parsed result must be asserted as a `TaskBrief`. If the model returns a
different type, if LangChain reports a parsing error, or if validation fails,
the planner should raise `StatigentParseError`. It should not fall back to
keyword heuristics. Fallback behavior hides prompt, schema, parser, and model
configuration failures that should be visible during development and
benchmarking.

The planner prompt should classify the request, identify the user's goal, select
the output type, and choose a complexity tier. It should not ask the model to
invent numeric budget values.

### Schema Descriptions

Structured output schema descriptions are prompts for the LLM, not programmer
comments. Descriptions should explain selection criteria and constraints. For
example:

- `task_type`: explain when to choose `data_analysis`, `data_modeling`,
  `deep_analysis`, or `unknown`.
- `output_type`: explain when the user expects a short answer, a report, or a
  file artifact.
- `complexity`: explain how to distinguish simple, moderate, and complex tasks.
- `requirements`: ask the model to preserve explicit user constraints.
- `analysis_hints`: ask for concrete analysis directions that may guide the
  Inspector.

Implementation-facing documentation belongs in class docstrings or project
docs, not in Pydantic field descriptions intended for structured output.

### Budget Tiers

The model selects a complexity tier. The system derives a fixed `Budget` from
that tier through `budget_for_complexity()` or an equivalent mapping.

Recommended tiers:

| Complexity | Rounds | Code cells | Debug attempts | Timeout |
| --- | ---: | ---: | ---: | ---: |
| `simple` | 2 | 4 | 1 | 120s |
| `moderate` | 5 | 10 | 2 | 300s |
| `complex` | 8 | 18 | 3 | 600s |

The exact numbers may remain configurable in code, but they should be system
controlled. The model should not emit arbitrary resource limits.

### Analysis Entrypoint Semantics

`StatigentDataScienceAgent.run_analysis_for_eval()` is the analysis benchmark
entrypoint. If the planner returns `data_modeling`, `deep_analysis`, or
`unknown`, the wrapper should treat that as a task classification error for
this entrypoint.

Behavior:

1. Append a warning to the trace and/or output warnings.
2. Replace `brief.task_type` with `data_analysis`.
3. Continue into the exploration layer instead of returning unsupported.

This keeps benchmark semantics stable. Modeling and deep analysis can still use
separate entrypoints or future routing, but `run_analysis_for_eval()` should not
silently switch to an unsupported path.

### Trace Events

Trace events should keep benchmark-compatible fields while adding explicit
provenance:

```python
class TraceEvent(BaseModel):
    role: str
    content: str
    name: str = ""
    agent: str
    session: int = 1
    metadata: dict[str, object] = Field(default_factory=dict)
```

`agent` identifies the component that produced the event, such as
`input_profiler`, `task_brief_planner`, `inspector`, `reviewer`, `coder`,
`debugger`, `notebook_kernel`, or `output_renderer`.

`session` identifies the independent context for that agent. The main Inspector
may use session `1` for the whole run. Each Debugger ReAct attempt should get a
new session number because it runs in its own context.

The public benchmark protocol can still return `AgentTrace` as a list of dicts.
Internally, the agent should construct typed `TraceEvent` instances and convert
them at the boundary.

## LangGraph Exploration Layer

### State Model

The exploration layer should use LangGraph internally. Other layers should not
depend on LangGraph state types.

The state should be represented by a typed model or typed dict named
`ExplorationRunState` with these fields:

- `brief`: current `TaskBrief`.
- `profile`: `DatasetProfile`.
- `steps`: completed `ExplorationStep` records.
- `notebook`: serializable notebook state or kernel snapshot.
- `pending_plan_text`: latest Inspector planning text.
- `review_feedback`: latest Reviewer rejection or final-review feedback.
- `approved_instruction`: latest Reviewer-approved code instruction.
- `last_cell_id`: most recent notebook cell under execution.
- `debug_lessons`: task-local debugger lessons.
- `final_draft`: Inspector final draft, if produced.
- `final_review`: final Reviewer decision, if produced.
- `warnings`: accumulated warnings.
- `trace_events`: typed trace events.
- `round_count`: number of Inspector planning rounds.
- `cell_count`: number of code cells appended.
- `debug_attempts`: debug attempts for the current failed cell.

Budget checks should live in graph routing functions where possible. Nodes
should update state and let conditional edges decide whether to continue,
retry, finish, or return partial output.

### Graph Topology

The main graph:

```text
inspector_plan
  -> reviewer_review_plan
    -> inspector_plan       # reviewer rejects plan
    -> coder_append_cell    # reviewer approves and emits coding instruction
      -> execute_cell
        -> debugger_react   # execution failed and debug budget remains
          -> replace_cell
          -> execute_cell
        -> inspector_observe # execution succeeded or debug abandoned
          -> inspector_plan  # continue exploration
          -> final_draft
            -> reviewer_review_final
              -> inspector_plan
              -> output_ready
```

Important routing rules:

- If plan review rejects the Inspector output, return to `inspector_plan` with
  Reviewer feedback.
- If cell execution fails and debug budget remains, enter `debugger_react`.
- If debug budget is exhausted, record a warning and return the observation to
  Inspector.
- If Inspector decides to stop, call `final_draft`.
- If final review rejects the draft and exploration budget remains, return to
  Inspector with final-review feedback.
- If final review rejects the draft and budget is exhausted, emit a partial
  report with warnings.
- If final review approves, emit a successful exploration report or modeling
  handoff.

### Inspector

Inspector planning should not use structured output. The point of the node is
to let the model reason about the task, previous observations, gaps, and
stopping criteria.

The prompt should ask Inspector to:

- Use the task brief, data profile, and prior observations.
- Prefer predefined DEA actions when possible.
- Explain why the next step is needed.
- Avoid redundant exploration.
- Stop when evidence is sufficient for the requested output.
- Place a lightweight action block at the end.

Required action block:

```text
ACTION: analyze_time_trend
QUESTION: Which time column best explains revenue trend?
EVIDENCE_NEEDED: monthly revenue aggregation and change rate
STOP: no
```

`ACTION` should name one `ExplorationActionKind` value or `custom_analysis`.
`STOP` should be `yes` only when Inspector believes final drafting should begin.

Inspector sees observations and summarized results. It should not see the full
Coder or Debugger private reasoning. It may see code outputs, artifact
descriptions, evidence summaries, warnings, and Reviewer feedback.

### Reviewer

Reviewer is the structured boundary after Inspector planning. It receives the
full Inspector text, task brief, profile summary, previous observations, budget
state, and available DEA action definitions.

Reviewer should output a structured `ReviewerPlanDecision`:

```python
class ReviewerPlanDecision(BaseModel):
    approved: bool
    reason: str
    action_kind: ExplorationActionKind | None
    question: str = ""
    evidence_needed: str = ""
    coding_instruction: str = ""
    action_prompt: str = ""
    constraints: list[str] = Field(default_factory=list)
```

Reviewer responsibilities:

- Reject plans that are irrelevant, redundant, unsafe, too broad, or unsupported
  by the available data.
- Parse the Inspector's action block.
- Confirm the action is necessary for the task objective.
- Fuse the predefined DEA action prompt into `action_prompt`.
- Produce `coding_instruction` that contains only code-relevant instructions for
  Coder.

If Reviewer rejects, `action_kind`, `coding_instruction`, and `action_prompt`
can be empty. The graph routes back to Inspector with `reason`.

### DEA Action Prompts

Each predefined `ExplorationActionKind` should have a carefully written prompt,
similar to a skill. These prompts describe how that analysis action should be
performed and what evidence it should produce.

Examples:

- `inspect_schema`: inspect table shapes, columns, dtypes, key identifiers, and
  obvious join keys.
- `profile_missingness`: compute missing counts and rates, identify columns
  whose missingness may affect conclusions.
- `analyze_time_trend`: identify usable time columns, normalize time grain, and
  summarize trend, seasonality, spikes, and changes.
- `analyze_group_comparison`: compare target metrics across categorical groups,
  including counts and effect sizes where useful.
- `validate_data_quality`: check duplicates, impossible values, inconsistent
  categories, and parsing issues.
- `answer_specific_question`: directly compute evidence for the user's stated
  question without broad exploratory detours.

Custom analysis remains available, but Reviewer should require a specific
question, expected evidence, and risk notes before approval.

### Coder

Coder receives only the Reviewer-approved code instruction fields. It should not
receive the full Inspector planning text unless that text has been filtered by
Reviewer.

Coder should bind an `append_code_cell` tool:

```python
append_code_cell(code: str, purpose: str, expected_observation: str) -> CellRef
```

The tool appends a notebook cell and returns a `cell_id`. It should not execute
the cell. Execution belongs to the graph's `execute_cell` node.

Coder prompt rules:

- Write one incremental Python cell.
- Use available input paths and previous notebook context.
- Prefer pandas, numpy, and plotting libraries already available in the
  environment.
- Print concise textual observations for Inspector.
- Save charts or tables through notebook artifact conventions when useful.
- Avoid training models in the exploration layer unless the action is a light
  diagnostic needed for EDA.

### Notebook Cell Lifecycle

The notebook kernel protocol should support cell lifecycle operations:

```python
append_code_cell(code: str, purpose: str, expected_observation: str) -> CellRef
replace_code_cell(
    cell_id: str,
    code: str,
    purpose: str,
    expected_observation: str,
) -> CellRef
execute_cell(cell_id: str) -> NotebookCellResult
get_code_context() -> NotebookCodeContext
```

`execute_cell()` should execute by `cell_id`, not by raw code string. This makes
append, replace, execution, trace, and debugging refer to the same durable cell
identity.

`get_code_context()` should return ordered cells with code, purpose, execution
status, stdout/stderr summaries, and error summaries. Debugger can receive the
full code context; Inspector should receive only summarized observations.

The existing fake and Docker notebook kernels can be adapted behind this
interface.

### Debugger

Debugger should be a ReAct-style agent created with `create_agent`. It runs in
an independent context for each failed cell. Each invocation gets a new
`session` value in trace events.

Debugger input:

- Task brief.
- Dataset profile summary.
- Full notebook code context.
- Failed cell id.
- Failed code.
- Error summary, stdout, stderr, and traceback if available.
- Current task-local `debug_lessons`.
- Reviewer-approved instruction for the cell.

Debugger tool:

```python
replace_code_cell(
    cell_id: str,
    code: str,
    purpose: str,
    expected_observation: str,
) -> CellRef
```

Debugger should only replace the failed cell. It should not append new
exploration cells and should not alter unrelated cells.

After debugging, it should return a structured summary:

```python
class DebugLesson(BaseModel):
    error_pattern: str
    root_cause: str
    fix_strategy: str
    applies_when: str
```

Lessons are stored only in the current `ExplorationRunState`. They are passed
to later debugger sessions for the same task and discarded when the task ends.

### Inspector Observation And Final Draft

After execution succeeds or debug is abandoned, the graph should summarize the
cell result for Inspector. The summary should include:

- The approved question.
- The executed cell purpose.
- Key stdout observations.
- Artifact descriptions.
- Error or warning summary if the cell failed.

Inspector then decides whether to continue or stop.

When stopping, Inspector produces `final_draft`. The draft type depends on the
task:

- Simple `data_analysis`: direct answer string with evidence.
- Report-style `data_analysis`: report text with evidence and caveats.
- `data_modeling`: structured EDA or data insight handoff report for the future
  modeling layer.
- `deep_analysis`: reserved for future commercial report expansion and not
  implemented in this redesign.

The modeling handoff should include dataset overview, target and metric clues
when known, candidate features, data quality risks, leakage risks, useful
transformations, and recommended modeling considerations. It should not run the
future modeling loop.

### Final Reviewer

Final Reviewer uses structured output. It should check:

- The draft answers the task objective.
- Claims are supported by exploration evidence.
- Required output type is respected.
- Warnings and uncertainty are surfaced.
- Additional exploration would materially improve the result.

If rejected and budget remains, the graph returns to Inspector with the final
review reason. If rejected and budget is exhausted, the output status becomes
partial and the warning is preserved.

## Prompt Architecture

Prompts should be treated as part of the architecture, not inline strings hidden
inside actor methods.

Recommended module:

```text
src/statigent/exploration/prompts.py
```

or, if prompts grow large:

```text
src/statigent/exploration/prompts/
```

Prompt groups:

- Task brief planning prompt.
- Inspector planning prompt.
- Reviewer plan-review prompt.
- DEA action prompts.
- Coder prompt.
- Debugger prompt.
- Inspector final-draft prompt.
- Final Reviewer prompt.

Prompt tests should verify key contract language exists, such as "do not
execute code", "append one cell", "replace only the failed cell", "Reviewer must
reject redundant exploration", and "Inspector must end with the action block".
Tests should not assert exact LLM prose beyond stable contract phrases.

## Error Handling

Expected error behavior:

- Structured output parse or validation failure raises `StatigentParseError`.
- Notebook lifecycle failures raise `StatigentNotebookError`.
- Tool misuse, such as replacing an unknown cell id, raises a specific notebook
  error.
- Unsupported task types at non-analysis entrypoints should render unsupported.
- Misclassified task types at `run_analysis_for_eval()` should warn and force
  `data_analysis`.
- Budget exhaustion should produce partial output, not an exception.

Exception chains should be preserved with `raise ... from err`.

## Testing Plan

### Input Layer

- Planner uses `BaseChatModel` and structured output.
- Non-`TaskBrief` parsed result raises `StatigentParseError`.
- LangChain parsing errors raise `StatigentParseError`.
- No deterministic fallback is used.
- Model-selected complexity maps to system-owned budgets.
- Schema descriptions contain LLM-facing selection guidance.

### Agent Wrapper

- `run_analysis_for_eval()` continues exploration for `data_analysis`.
- `run_analysis_for_eval()` warns and coerces non-analysis task types to
  `data_analysis`.
- Trace events include `agent` and `session`.
- Benchmark-compatible trace dicts are still returned.

### LangGraph Routing

- Reviewer rejection routes back to Inspector.
- Reviewer approval routes to Coder.
- Coder appends a cell without executing it.
- Execute node runs the appended cell by id.
- Failed execution enters Debugger while budget remains.
- Debugger replaces the failed cell and execution retries by same cell id.
- Debug lessons are available to later debugger sessions in the same run.
- Debug lessons do not persist after the run.
- Final review rejection routes back to Inspector when budget remains.
- Budget exhaustion produces partial output.
- Final review approval produces output-ready state.

### Notebook Tools

- `append_code_cell` returns stable cell ids.
- `replace_code_cell` preserves cell identity while replacing code.
- `execute_cell` records stdout, stderr, duration, artifacts, and status.
- `get_code_context` returns ordered notebook context.
- Artifact references remain valid after rendering.

### Prompt Contracts

- Inspector prompt requires the action block.
- Reviewer prompt requires relevance, necessity, and redundancy checks.
- Coder prompt instructs one incremental cell and no execution.
- Debugger prompt restricts edits to the failed cell.
- Final Reviewer prompt checks evidence support and output constraints.

## Implementation Slices

The work should be implemented as separate tasks and commits:

1. Fix input-layer contracts: `BaseChatModel`, parse errors, budget tier mapping,
   and LLM-facing schema descriptions.
2. Upgrade trace schema and `run_analysis_for_eval()` task coercion behavior.
3. Extend notebook kernel cell lifecycle and tool wrappers.
4. Redesign exploration schemas and actor interfaces.
5. Implement the LangGraph exploration state graph.
6. Add Debugger ReAct sessions and task-local debug lessons.
7. Move prompts into a prompt module and add prompt contract tests.
8. Update architecture docs and benchmark smoke tests.

This order keeps risky graph behavior behind already-tested contracts and makes
each commit reviewable.
