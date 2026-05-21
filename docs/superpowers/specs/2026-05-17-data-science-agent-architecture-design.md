# Data Science Agent Architecture Design

Date: 2026-05-17

## Context

Statigent currently has benchmark adapters, model configuration and registry
support, a Docker sandbox, and a simple ReAct baseline agent. The next step is
to introduce the architecture skeleton for a data science agent focused on
input understanding, data exploration, and output generation.

This design prioritizes architecture over benchmark score. The first version
must establish clear module boundaries, structured-but-flexible data contracts,
and an explicit multi-agent exploration loop. It must keep the existing
`DataScienceAgent` benchmark protocol compatible, but benchmark optimization is
not the main goal.

## Architectural Constraints

- Use only LangChain foundation capabilities such as model abstraction, tool
  binding, and structured output.
- Do not introduce high-level orchestration frameworks such as LangGraph or
  deepagents for the core agent workflow.
- Keep `ReactBaselineAgent` as the baseline. The new agent is a separate
  implementation.
- Reuse `src/statigent/models` for all LLM construction.
- Keep data science execution behind a notebook-oriented abstraction instead of
  exposing the existing baseline `DockerSandbox` directly.
- Do not implement the full data modeling or deep analysis layers in this
  phase. Define their routing and placeholder behavior only.

## Goals

- Define the first production-shaped architecture skeleton for the Statigent
  data science agent.
- Implement an input layer that accepts prompts plus local files, directories,
  and archives, then generates a task brief.
- Implement a data exploration layer with real LLM-backed `Inspector`,
  `Reviewer`, `Coder`, and `Debugger` roles.
- Implement a notebook kernel abstraction designed for incremental data
  analysis execution.
- Implement an output layer that routes by requested output type.
- Preserve compatibility with the existing `DataScienceAgent` protocol.

## Non-Goals

- Optimizing benchmark performance.
- Implementing the future data modeling agent.
- Implementing the future deep commercial analysis report workflow.
- Replacing the benchmark adapters.
- Building a UI.

## Package Structure

The first version should add modules with clear responsibilities:

- `statigent.schemas`: Pydantic boundary models shared across layers.
- `statigent.input`: file normalization, table discovery, lightweight
  profiling, and task brief generation.
- `statigent.notebook`: notebook kernel interfaces, cell execution results,
  artifacts, and notebook state.
- `statigent.exploration`: explicit Python orchestrator and LLM actor roles.
- `statigent.output`: output bundle construction and rendering.
- `statigent.agents`: user-facing agent implementation that satisfies
  `DataScienceAgent`.

The expected data flow is:

```text
prompt/files
  -> InputLayer
  -> TaskBrief + DatasetProfile
  -> ExplorationOrchestrator
  -> ExplorationReport + Artifacts
  -> OutputLayer
  -> OutputBundle
  -> benchmark-compatible response/trace
```

## Core Schemas

The system uses semi-structured Pydantic models. Key fields must be structured,
while prose, rationale, report bodies, and observations can remain Markdown
text.

### TaskBrief

`TaskBrief` describes the normalized task.

Required fields:

- `task_type`: one of `data_analysis`, `data_modeling`, `deep_analysis`,
  `unknown`.
- `objective`: standardized description of the user goal.
- `output_type`: one of `answer`, `report`, `file`.
- `requirements`: output format, benchmark constraints, business rules, and
  user constraints.
- `data_context`: compact profile of available datasets, table relationships,
  and likely key columns.
- `complexity`: one of `simple`, `moderate`, `complex`.
- `budgets`: hard limits for exploration rounds, code cells, debug attempts,
  and runtime.
- `analysis_hints`: optional initial analysis directions.
- `warnings`: ambiguity, file issues, or data quality concerns.

### DatasetProfile

`DatasetProfile` summarizes discovered input data. It should include files,
tables, row and column counts, column names, dtypes, missingness, unique counts,
numeric summaries, likely time columns, likely categorical columns, and sample
rows.

### ExplorationAction

`ExplorationAction` represents the Inspector's proposed next step. It supports
predefined data exploration actions and a controlled free-form action.

Predefined actions:

- `inspect_schema`
- `profile_missingness`
- `summarize_numeric`
- `summarize_categorical`
- `analyze_time_trend`
- `analyze_group_comparison`
- `analyze_correlation`
- `detect_outliers`
- `validate_data_quality`
- `create_visualization`
- `answer_specific_question`

Free-form action:

- `custom_analysis`

`custom_analysis` must include a rationale, expected evidence, and risk notes.
The Reviewer must apply stricter approval rules to custom actions.

### NotebookCellResult

`NotebookCellResult` records incremental execution:

- `cell_id`
- `code`
- `purpose`
- `stdout`
- `stderr`
- `exit_code`
- `duration_ms`
- `artifacts`
- `error_summary`

### OutputBundle

`OutputBundle` is the output layer boundary. It includes:

- `status`: `success`, `partial`, `unsupported`, or `error`.
- `output_type`
- `content`
- `artifacts`
- `warnings`
- `trace_summary`

## Input Layer

The input layer accepts a user prompt, optional benchmark task instructions,
and optional paths. Paths can point to files, directories, or compressed
archives.

The first version focuses on tabular data:

- CSV
- TSV
- Excel (`xlsx`, `xls`)
- Parquet

Directories are scanned recursively with file count and size limits. Archives
are extracted into a controlled work directory before scanning. Non-tabular
files are registered as metadata only.

Profiling is intentionally lightweight:

- row and column counts
- column names and dtypes
- missingness by column
- unique counts
- numeric summaries
- likely time columns
- likely categorical columns
- sample rows

The input layer uses a two-stage process:

1. Deterministic profiling builds `DatasetProfile`.
2. An LLM receives the prompt, benchmark instructions, and compact profile
   summary, then generates `TaskBrief` via LangChain structured output.

If structured parsing fails, the raw LLM response is recorded and the system
falls back to a minimal rule-generated `TaskBrief`.

## Task Routing

`data_analysis` enters the data exploration layer and produces the requested
output.

`data_modeling` enters the data exploration layer only to produce an EDA-style
report. The modeling layer is not implemented in this phase. The output should
return a structured `unsupported` or `partial` result that clearly says the
modeling layer is not available yet.

`deep_analysis` is reserved for future commercial deep analysis reports. The
first version may recognize this task type, but it must not route it through
ordinary `data_analysis` as if it were implemented. It returns a structured
`unsupported` result and may include the basic dataset profile.

`unknown` should return a clarification or error-style result instead of
guessing.

## Complexity and Budgets

The input layer assigns complexity and budgets.

Simple tasks include short questions, single-table aggregation, or direct
lookups. They should finish quickly with low exploration budgets.

Moderate tasks include multi-table joins, time trends, grouped comparisons,
and several related calculations.

Complex tasks include extensive cleaning, unclear objectives, statistical
tests, many artifacts, or multi-step exploratory analysis.

Budgets are hard limits. The Reviewer can request more exploration within the
budget, but cannot exceed it.

## Notebook Kernel

The notebook layer defines a data-analysis-oriented execution interface:

- `start(context)`
- `close()`
- `execute_cell(code, purpose) -> NotebookCellResult`
- `read_file(path, max_bytes/max_rows) -> FileReadResult`
- `write_artifact(name, content/path, kind) -> ArtifactRef`
- `list_inputs()`
- `list_artifacts()`
- `snapshot() -> NotebookState`

The kernel must preserve notebook-style incremental Python state so later
cells can reuse variables, imports, and loaded data from earlier cells.

The first concrete implementation can be a `DockerNotebookKernel`, but Docker
details must remain hidden behind the notebook interface. The implementation is
responsible for lifecycle management, input mounting, working directories,
artifact directories, timeouts, and cleanup.

## Exploration Layer

The exploration layer is an explicit Python orchestrator, not a graph framework.
It coordinates four real LLM-backed roles:

- `Inspector`: reads the task brief, dataset profile, notebook state, prior
  observations, and reviewer feedback. It proposes an `ExplorationAction` or
  a final draft.
- `Reviewer`: reviews proposed actions for relevance, necessity, safety, and
  expected value. It also reviews the final draft for answer quality,
  sufficiency of evidence, and format compliance.
- `Coder`: converts an approved exploration action into notebook cell code and
  states the expected observation.
- `Debugger`: receives failed code, errors, notebook state, and action context.
  It returns a corrected cell or recommends abandoning the action.

The core loop is:

1. Inspector proposes the next action.
2. Reviewer approves, rejects, or requests revisions.
3. Coder writes a notebook cell.
4. Kernel executes the cell.
5. Debugger handles failures within the debug budget.
6. The result is returned to Inspector.
7. Inspector either continues exploration or drafts the final answer/report.
8. Reviewer performs final review.
9. If final review fails and budget remains, Inspector continues exploration.
10. If final review passes or budget is exhausted, the orchestrator returns.

When budget is exhausted, the system should return the best result supported by
the collected evidence and include limitations in `warnings`.

## Output Layer

The output layer renders by `TaskBrief.output_type`.

For `answer`, it returns a concise answer, essential evidence, and artifacts.

For `report`, it returns a Markdown report with methods, findings, evidence,
limitations, and recommendations. Charts, tables, generated code, and files are
referenced through artifacts.

For `file`, it returns generated file paths, format descriptions, validation
status, and a short explanatory summary.

Unsupported or not-yet-implemented task types must return explicit structured
results instead of pretending the task has been completed.

## Trace

The system must keep the current benchmark-compatible `AgentTrace` shape while
also recording richer internal events.

Trace events should cover:

- input profile summaries
- task brief generation and fallback information
- actor role, model name, input summary, and structured output
- reviewer decisions and reasons
- notebook cell code, output summaries, errors, and artifacts
- debugger attempts and outcomes
- final output bundle

## Error Handling

Input errors include missing files, unreadable archives, unsupported table
formats, table read failures, and files exceeding configured limits.

LLM output errors include structured parsing failures and missing critical
fields. These should fall back where possible and add warnings.

Execution errors enter the Debugger path. If debug budget is exhausted, the
failed action is recorded as a warning and the Inspector decides whether to
continue.

Final review failures should lead to more exploration if budget remains.
Otherwise, return a partial result with limitations.

Unrecoverable notebook startup, sandbox, or filesystem failures should raise a
`StatigentError` subclass.

## Testing Strategy

Unit tests should cover schema defaults, enum validation, and budget
assignment.

Input tests should use temporary CSV, TSV, Excel, Parquet, directory, and zip
fixtures to verify scanning and profiling behavior.

Exploration orchestrator tests should use fake LLM actors and a fake notebook
kernel to cover action approval, rejection, debug retry, final review failure,
and budget exhaustion.

Notebook kernel integration tests should be marked `integration` or `slow`
when they require Docker or long-running execution.

Agent protocol tests should confirm the new agent implements
`run_analysis_for_eval` and returns explicit placeholder output for
`data_modeling` and `deep_analysis`.

Benchmark smoke tests should confirm that the new agent can be passed to the
existing benchmark adapters without changing the `DataScienceAgent` protocol.

## Acceptance Criteria

- A new architecture skeleton exists without modifying `ReactBaselineAgent`.
- The new agent uses `src/statigent/models` for LLM construction.
- The input layer can profile tabular files, directories, and archives.
- The task brief supports `data_analysis`, `data_modeling`, `deep_analysis`,
  and `unknown`.
- The exploration layer has real LLM-backed Inspector, Reviewer, Coder, and
  Debugger roles.
- The notebook layer exposes an incremental execution abstraction.
- The output layer routes by `answer`, `report`, and `file`.
- Unsupported `data_modeling` and `deep_analysis` flows return explicit
  structured results.
- Existing benchmark protocol compatibility is preserved.
