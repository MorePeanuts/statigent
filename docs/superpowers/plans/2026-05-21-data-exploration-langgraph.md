# Data Exploration LangGraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the data science agent from a linear exploration skeleton to a typed, testable LangGraph-based data exploration layer with corrected input contracts, trace provenance, notebook cell lifecycle tools, and prompt contracts.

**Architecture:** Keep cross-layer boundaries plain Python and Pydantic. Use LangGraph only inside `statigent.exploration`; input, notebook, output, and benchmark wrappers remain decoupled. Reviewer and Final Reviewer use structured output, while Inspector uses text planning and Coder/Debugger work through bound tools.

**Tech Stack:** Python 3.12, Pydantic, LangChain chat models, LangGraph, pytest, ruff, mypy, loguru.

---

## File Structure

- Modify `src/statigent/schemas.py`: update budgets, trace schema, task brief descriptions, exploration review/final/debug schemas, notebook cell models.
- Modify `src/statigent/input/planner.py`: accept `BaseChatModel`, remove fallback, assert parsed `TaskBrief`, derive budgets in code.
- Modify `tests/input/test_planner.py`: rewrite tests around explicit parse errors and budget derivation.
- Modify `src/statigent/agents/data_science.py`: add typed trace events and coerce non-analysis briefs in `run_analysis_for_eval()`.
- Modify `tests/agents/test_data_science_agent.py`: cover trace metadata and task-type coercion.
- Modify `src/statigent/notebook/base.py`: add cell lifecycle protocols and code-context models.
- Modify `src/statigent/notebook/fake.py`: implement append, replace, execute-by-id, code context.
- Modify `src/statigent/notebook/docker.py`: adapt Docker kernel to the new lifecycle while preserving current execution semantics.
- Modify `tests/notebook/test_fake_kernel.py` and `tests/notebook/test_docker_kernel.py`: cover lifecycle behavior.
- Create `src/statigent/exploration/prompts.py`: centralize task, actor, action, debugger, and final-review prompt text.
- Create `tests/exploration/test_prompts.py`: prompt contract tests.
- Modify `src/statigent/exploration/actors.py`: Inspector text planning, Reviewer structured decisions, Coder tool calling, Debugger tool calling.
- Create `src/statigent/exploration/state.py`: `ExplorationRunState` and routing helpers.
- Modify `src/statigent/exploration/orchestrator.py`: compile and run the LangGraph state graph.
- Modify `tests/exploration/test_actors.py` and `tests/exploration/test_orchestrator.py`: route, budget, debug, final-review tests.
- Modify `docs/architecture_zh.md`: update architecture description after code lands.

## Task 1: Input Contract And Budget Derivation

**Files:**
- Modify: `src/statigent/schemas.py`
- Modify: `src/statigent/input/planner.py`
- Test: `tests/input/test_planner.py`
- Test: `tests/test_schemas.py`

- [ ] **Step 1: Write failing schema tests**

Add tests that assert larger fixed budgets and LLM-facing field meanings:

```python
def test_budget_for_complexity_uses_fixed_system_tiers() -> None:
    assert budget_for_complexity(Complexity.SIMPLE) == Budget(
        max_rounds=3,
        max_code_cells=6,
        max_debug_attempts=2,
        timeout_seconds=180,
    )
    assert budget_for_complexity(Complexity.MODERATE) == Budget(
        max_rounds=7,
        max_code_cells=14,
        max_debug_attempts=3,
        timeout_seconds=480,
    )
    assert budget_for_complexity(Complexity.COMPLEX) == Budget(
        max_rounds=12,
        max_code_cells=28,
        max_debug_attempts=5,
        timeout_seconds=900,
    )


def test_task_brief_field_descriptions_define_what_not_how() -> None:
    schema = TaskBrief.model_json_schema()
    task_type_description = schema["properties"]["task_type"]["description"]
    complexity_description = schema["properties"]["complexity"]["description"]

    assert "category" in task_type_description.casefold()
    assert "effort tier" in complexity_description.casefold()
    assert "choose when" not in task_type_description.casefold()
    assert "analyze by" not in complexity_description.casefold()
```

- [ ] **Step 2: Run schema tests and verify failure**

Run:

```bash
uv run pytest tests/test_schemas.py -q
```

Expected: fails because current budgets are `2/4/1/120`, `5/10/2/300`, and `8/18/3/600`, and current descriptions do not match the new wording.

- [ ] **Step 3: Write failing planner tests**

Replace fallback-oriented tests in `tests/input/test_planner.py` with explicit error tests:

```python
def test_planner_raises_parse_error_for_structured_output_error(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(parsing_error=ValueError("bad json")))

    with pytest.raises(StatigentParseError):
        planner.create_brief(
            prompt="Summarize the dataset",
            task_instructions="",
            profile=make_profile(tmp_path),
        )


def test_planner_raises_parse_error_for_wrong_parsed_type(tmp_path: Path) -> None:
    planner = TaskBriefPlanner(model=FakeModel(result="not a task brief"))

    with pytest.raises(StatigentParseError):
        planner.create_brief(
            prompt="Analyze revenue trend",
            task_instructions="",
            profile=make_profile(tmp_path),
        )


def test_planner_derives_budget_from_complexity(tmp_path: Path) -> None:
    expected = TaskBrief(
        task_type=TaskType.DATA_ANALYSIS,
        objective="Analyze revenue trend",
        output_type=OutputType.REPORT,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.MODERATE,
        budgets=Budget(max_rounds=1, max_code_cells=1, max_debug_attempts=0, timeout_seconds=1),
    )
    planner = TaskBriefPlanner(model=FakeModel(expected))

    brief = planner.create_brief(
        prompt="Analyze revenue trend",
        task_instructions="",
        profile=make_profile(tmp_path),
    )

    assert brief.budgets == budget_for_complexity(Complexity.MODERATE)
```

The fake model may need its `result` type widened to `object`.

- [ ] **Step 4: Run planner tests and verify failure**

Run:

```bash
uv run pytest tests/input/test_planner.py -q
```

Expected: fails because current planner catches parse errors and returns fallback briefs.

- [ ] **Step 5: Implement schema changes**

Update `budget_for_complexity()` and `TaskBrief` field descriptions in `src/statigent/schemas.py`:

```python
def budget_for_complexity(complexity: Complexity) -> Budget:
    """Return the system-owned resource budget for a complexity tier."""
    if complexity is Complexity.SIMPLE:
        return Budget(max_rounds=3, max_code_cells=6, max_debug_attempts=2, timeout_seconds=180)
    if complexity is Complexity.MODERATE:
        return Budget(max_rounds=7, max_code_cells=14, max_debug_attempts=3, timeout_seconds=480)
    return Budget(max_rounds=12, max_code_cells=28, max_debug_attempts=5, timeout_seconds=900)
```

Use descriptions like:

```python
task_type: TaskType = Field(description="Category of the task requested by the user")
output_type: OutputType = Field(description="Shape of the deliverable requested by the user")
complexity: Complexity = Field(description="Expected effort tier for completing the task")
budgets: Budget = Field(description="System-derived resource caps for the selected effort tier")
```

- [ ] **Step 6: Implement planner changes**

In `src/statigent/input/planner.py`:

```python
from langchain.chat_models.base import BaseChatModel

class TaskBriefPlanner:
    def __init__(self, model: BaseChatModel) -> None:
        self.model = model
```

Remove `_TaskBriefModel`, `_StructuredTaskBriefModel`, `_fallback_brief()`, `_fallback_classification()`, `_fallback_requirements()`, and `_contains_any()`.

After invoking structured output:

```python
result = retry_on_parse_error(invoke_structured_with_retries)(structured_model, messages)
if not isinstance(result, TaskBrief):
    raise StatigentParseError(
        f"Task brief structured output returned {type(result).__name__}, expected TaskBrief"
    )
return result.model_copy(update={"budgets": budget_for_complexity(result.complexity)})
```

Keep `StatigentParseError` chains where converting lower-level exceptions is needed.

- [ ] **Step 7: Run focused checks**

Run:

```bash
uv run pytest tests/input/test_planner.py tests/test_schemas.py -q
uv run ruff check src/statigent/input/planner.py src/statigent/schemas.py tests/input/test_planner.py tests/test_schemas.py
uv run mypy src
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/statigent/schemas.py src/statigent/input/planner.py tests/input/test_planner.py tests/test_schemas.py
git commit -m "fix: tighten task brief planning contract" -m "Use BaseChatModel directly, remove deterministic planner fallback, derive resource budgets from complexity tiers, and update task brief field descriptions to define what each field represents for structured output."
```

## Task 2: Trace Events And Analysis Entrypoint Coercion

**Files:**
- Modify: `src/statigent/schemas.py`
- Modify: `src/statigent/agents/data_science.py`
- Test: `tests/agents/test_data_science_agent.py`

- [ ] **Step 1: Write failing trace schema test**

Add to `tests/test_schemas.py`:

```python
def test_trace_event_requires_agent_and_session() -> None:
    event = TraceEvent(
        role="assistant",
        content="planned",
        name="task_brief",
        agent="task_brief_planner",
        session=1,
    )

    assert event.model_dump()["agent"] == "task_brief_planner"
    assert event.model_dump()["session"] == 1
```

- [ ] **Step 2: Write failing agent wrapper test**

Add to `tests/agents/test_data_science_agent.py`:

```python
def test_analysis_eval_coerces_non_analysis_brief(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    brief = make_brief(TaskType.DATA_MODELING)
    seen: list[TaskType] = []

    class CapturingOrchestrator:
        def run(self, run_brief: TaskBrief, _profile: DatasetProfile) -> ExplorationReport:
            seen.append(run_brief.task_type)
            return FakeOrchestrator().run(run_brief, _profile)

    def factory(_brief: TaskBrief, _profile: DatasetProfile, _work_dir: Path) -> CapturingOrchestrator:
        return CapturingOrchestrator()

    agent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(brief),
        orchestrator_factory=factory,
    )

    response, trace = agent.run_analysis_for_eval("predict", files=[])

    assert response == "Answer is 42"
    assert seen == [TaskType.DATA_ANALYSIS]
    assert any("coerced" in event["content"].casefold() for event in trace)
    assert all("agent" in event and "session" in event for event in trace)
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
uv run pytest tests/agents/test_data_science_agent.py tests/test_schemas.py -q
```

Expected: fails because `TraceEvent` lacks `agent/session`, and `run_analysis_for_eval()` currently returns unsupported for non-analysis briefs.

- [ ] **Step 4: Implement trace schema**

Update `TraceEvent`:

```python
class TraceEvent(BaseModel):
    """Single event in an agent trace for benchmarking and observability."""

    role: str = Field(description="Message role for benchmark trace compatibility")
    content: str = Field(description="Event payload")
    name: str = Field(default="", description="Tool, phase, or action identifier")
    agent: str = Field(description="Agent or layer that produced the event")
    session: int = Field(default=1, ge=1, description="Independent session number for this agent")
    metadata: dict[str, object] = Field(default_factory=dict, description="Additional event metadata")
```

- [ ] **Step 5: Implement analysis coercion**

In `StatigentDataScienceAgent.run_analysis_for_eval()`:

```python
trace_events = [
    TraceEvent(role="system", content=profile.compact_summary(), name="input", agent="input_profiler"),
    TraceEvent(role="assistant", content=brief.model_dump_json(), name="task_brief", agent="task_brief_planner"),
]
if brief.task_type is not TaskType.DATA_ANALYSIS:
    warning = f"run_analysis_for_eval received {brief.task_type}; coerced to data_analysis."
    brief = brief.model_copy(update={"task_type": TaskType.DATA_ANALYSIS, "warnings": [*brief.warnings, warning]})
    trace_events.append(
        TraceEvent(role="assistant", content=warning, name="task_type_coercion", agent="data_science_agent")
    )
```

Convert to benchmark trace at return:

```python
trace: AgentTrace = [event.model_dump() for event in trace_events]
```

- [ ] **Step 6: Run focused checks**

Run:

```bash
uv run pytest tests/agents/test_data_science_agent.py tests/test_schemas.py -q
uv run ruff check src/statigent/agents/data_science.py src/statigent/schemas.py tests/agents/test_data_science_agent.py tests/test_schemas.py
uv run mypy src
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/statigent/schemas.py src/statigent/agents/data_science.py tests/agents/test_data_science_agent.py tests/test_schemas.py
git commit -m "fix: add trace provenance and analysis task coercion" -m "Extend trace events with agent and session metadata, keep benchmark-compatible dict output, and make run_analysis_for_eval warn and coerce misclassified task briefs back to data_analysis."
```

## Task 3: Notebook Cell Lifecycle

**Files:**
- Modify: `src/statigent/schemas.py`
- Modify: `src/statigent/notebook/base.py`
- Modify: `src/statigent/notebook/fake.py`
- Modify: `src/statigent/notebook/docker.py`
- Test: `tests/notebook/test_fake_kernel.py`
- Test: `tests/notebook/test_docker_kernel.py`

- [ ] **Step 1: Write fake kernel lifecycle tests**

Add:

```python
def test_fake_kernel_appends_executes_and_replaces_cells(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="bad\n", exit_code=1, stderr="NameError")
    kernel.queue_result(stdout="fixed\n")
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))

    cell = kernel.append_code_cell("print(missing)", "Fail once", "error")
    first = kernel.execute_cell(cell.cell_id)
    replaced = kernel.replace_code_cell(cell.cell_id, "print('fixed')", "Fix", "fixed")
    second = kernel.execute_cell(replaced.cell_id)
    context = kernel.get_code_context()

    assert cell.cell_id == replaced.cell_id
    assert not first.ok
    assert second.ok
    assert context.cells[0].code == "print('fixed')"
    assert context.cells[0].latest_result is not None
```

- [ ] **Step 2: Run fake kernel test and verify failure**

Run:

```bash
uv run pytest tests/notebook/test_fake_kernel.py -q
```

Expected: fails because lifecycle methods and code-context models do not exist.

- [ ] **Step 3: Add notebook cell schemas**

In `src/statigent/schemas.py` add:

```python
class NotebookCell(BaseModel):
    """A durable notebook code cell."""

    cell_id: str
    code: str
    purpose: str
    expected_observation: str
    latest_result: NotebookCellResult | None = None


class NotebookCodeContext(BaseModel):
    """Ordered notebook code context for coder and debugger agents."""

    cells: list[NotebookCell] = Field(default_factory=list)
```

Add both names to `__all__`.

- [ ] **Step 4: Update NotebookKernel protocol**

In `src/statigent/notebook/base.py`:

```python
def append_code_cell(self, code: str, purpose: str, expected_observation: str) -> NotebookCell: ...
def replace_code_cell(self, cell_id: str, code: str, purpose: str, expected_observation: str) -> NotebookCell: ...
def execute_cell(self, cell_id: str) -> NotebookCellResult: ...
def get_code_context(self) -> NotebookCodeContext: ...
```

Keep `read_file`, `write_artifact`, `list_inputs`, `list_artifacts`, and `snapshot`.

- [ ] **Step 5: Implement fake kernel lifecycle**

In `FakeNotebookKernel`, store ordered `NotebookCell` objects:

```python
self._cells: list[NotebookCell] = []
```

Implement:

```python
def append_code_cell(self, code: str, purpose: str, expected_observation: str) -> NotebookCell:
    cell = NotebookCell(
        cell_id=f"cell-{len(self._cells) + 1}",
        code=code,
        purpose=purpose,
        expected_observation=expected_observation,
    )
    self._cells.append(cell)
    return cell
```

`replace_code_cell()` should find by id and replace code while preserving id. If missing, raise `StatigentNotebookError(f"Unknown notebook cell id: {cell_id}")`.

`execute_cell(cell_id)` should find the cell, consume queued result, build `NotebookCellResult` using the cell code and purpose, update that cell's `latest_result`, append to `NotebookState.executed_cells`, and return the result.

- [ ] **Step 6: Adapt Docker kernel**

Keep Docker execution internals, but route execution through stored cells. Implement append/replace/get context with the same semantics as fake kernel. The Docker `execute_cell(cell_id)` should execute the stored cell code and update `latest_result`.

- [ ] **Step 7: Run notebook checks**

Run:

```bash
uv run pytest tests/notebook/test_fake_kernel.py tests/notebook/test_docker_kernel.py -q
uv run ruff check src/statigent/notebook src/statigent/schemas.py tests/notebook
uv run mypy src
```

Expected: all pass. If Docker is unavailable, preserve the existing skip behavior in Docker tests.

- [ ] **Step 8: Commit**

```bash
git add src/statigent/schemas.py src/statigent/notebook/base.py src/statigent/notebook/fake.py src/statigent/notebook/docker.py tests/notebook/test_fake_kernel.py tests/notebook/test_docker_kernel.py
git commit -m "feat: add notebook cell lifecycle" -m "Introduce durable notebook cells, code context snapshots, append and replace operations, and execute-by-cell-id semantics across fake and Docker notebook kernels."
```

## Task 4: Prompt Contracts And Exploration Schemas

**Files:**
- Create: `src/statigent/exploration/prompts.py`
- Modify: `src/statigent/schemas.py`
- Test: `tests/exploration/test_prompts.py`
- Test: `tests/test_schemas.py`

- [ ] **Step 1: Write prompt contract tests**

Create `tests/exploration/test_prompts.py`:

```python
from statigent.exploration.prompts import (
    CODER_SYSTEM_PROMPT,
    DEBUGGER_SYSTEM_PROMPT,
    INSPECTOR_PLAN_SYSTEM_PROMPT,
    REVIEWER_PLAN_SYSTEM_PROMPT,
)


def test_inspector_prompt_requires_action_block() -> None:
    assert "ACTION:" in INSPECTOR_PLAN_SYSTEM_PROMPT
    assert "STOP:" in INSPECTOR_PLAN_SYSTEM_PROMPT


def test_coder_prompt_requires_append_without_execution() -> None:
    text = CODER_SYSTEM_PROMPT.casefold()
    assert "append_code_cell" in text
    assert "do not execute" in text


def test_debugger_prompt_uses_prebound_replace_tool() -> None:
    text = DEBUGGER_SYSTEM_PROMPT.casefold()
    assert "replace_code_cell" in text
    assert "already bound" in text


def test_reviewer_prompt_rejects_redundant_exploration() -> None:
    assert "redundant" in REVIEWER_PLAN_SYSTEM_PROMPT.casefold()
```

- [ ] **Step 2: Write schema tests**

Add:

```python
def test_reviewer_plan_decision_allows_rejection_without_action() -> None:
    decision = ReviewerPlanDecision(approved=False, reason="Redundant")
    assert decision.action_kind is None


def test_debug_lesson_records_task_local_fix() -> None:
    lesson = DebugLesson(
        error_pattern="NameError",
        root_cause="Column variable was misspelled",
        fix_strategy="Use df.columns to confirm names",
        applies_when="Column access fails",
    )
    assert lesson.error_pattern == "NameError"
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/exploration/test_prompts.py tests/test_schemas.py -q
```

Expected: fails because prompt module and new schemas do not exist.

- [ ] **Step 4: Add prompt module**

Create `src/statigent/exploration/prompts.py` with public constants:

```python
INSPECTOR_PLAN_SYSTEM_PROMPT = """You are the Inspector for a data exploration task.
Reason about the task, prior observations, evidence gaps, and whether more exploration is needed.
End every planning response with:
ACTION: <one exploration action kind or custom_analysis>
QUESTION: <specific question for the next step>
EVIDENCE_NEEDED: <evidence the step should produce>
STOP: <yes or no>
"""

REVIEWER_PLAN_SYSTEM_PROMPT = """You are the Reviewer.
Reject plans that are irrelevant, redundant, unsafe, too broad, unsupported by the data, or not necessary for the task objective.
Return a ReviewerPlanDecision structured output.
"""

CODER_SYSTEM_PROMPT = """You are the Coder.
Use append_code_cell to add exactly one incremental notebook cell.
Do not execute code.
"""

DEBUGGER_SYSTEM_PROMPT = """You are the Debugger.
Use replace_code_cell to replace the failed cell. The tool is already bound to the failed cell id.
Record reusable lessons with record_debug_lesson when a fix pattern may help later in this task.
"""
```

Add DEA action prompt mapping:

```python
DEA_ACTION_PROMPTS: dict[ExplorationActionKind, str] = {
    ExplorationActionKind.INSPECT_SCHEMA: "Inspect table shapes, columns, dtypes, identifiers, and possible join keys.",
    ...
}
```

- [ ] **Step 5: Add schemas**

In `src/statigent/schemas.py` add `ReviewerPlanDecision`, `FinalReviewDecision`, `ApprovedCodeInstruction`, `DebugLesson`, and `ExplorationObservation`. Keep old schemas only if tests or wrappers still need them during transition.

- [ ] **Step 6: Run focused checks**

Run:

```bash
uv run pytest tests/exploration/test_prompts.py tests/test_schemas.py -q
uv run ruff check src/statigent/exploration/prompts.py src/statigent/schemas.py tests/exploration/test_prompts.py tests/test_schemas.py
uv run mypy src
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/statigent/exploration/prompts.py src/statigent/schemas.py tests/exploration/test_prompts.py tests/test_schemas.py
git commit -m "feat: add exploration prompt and review schemas" -m "Centralize exploration prompt contracts and add schema boundaries for reviewer decisions, final review decisions, approved code instructions, task-local debug lessons, and observations."
```

## Task 5: Actor Interfaces And Tool Wrappers

**Files:**
- Modify: `src/statigent/exploration/actors.py`
- Create: `src/statigent/exploration/tools.py`
- Test: `tests/exploration/test_actors.py`

- [ ] **Step 1: Write actor behavior tests with fakes**

Add tests that assert Inspector returns text, Reviewer returns `ReviewerPlanDecision`, Coder calls append tool, and Debugger replace tool hides `cell_id`.

```python
def test_debugger_replace_tool_is_bound_to_failed_cell(tmp_path: Path) -> None:
    kernel = FakeNotebookKernel()
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))
    cell = kernel.append_code_cell("print(missing)", "Fail", "error")
    tool = make_replace_code_cell_tool(kernel, cell.cell_id)

    replaced = tool.invoke({"code": "print('fixed')", "purpose": "Fix", "expected_observation": "fixed"})

    assert replaced.cell_id == cell.cell_id
    assert kernel.get_code_context().cells[0].code == "print('fixed')"
```

- [ ] **Step 2: Run actor tests and verify failure**

Run:

```bash
uv run pytest tests/exploration/test_actors.py -q
```

Expected: fails because tool wrappers and actor methods are still old.

- [ ] **Step 3: Implement tool wrappers**

Create `src/statigent/exploration/tools.py`:

```python
from langchain_core.tools import StructuredTool

def make_append_code_cell_tool(kernel: NotebookKernel) -> StructuredTool:
    def append_code_cell(code: str, purpose: str, expected_observation: str) -> NotebookCell:
        return kernel.append_code_cell(code, purpose, expected_observation)
    return StructuredTool.from_function(append_code_cell)


def make_replace_code_cell_tool(kernel: NotebookKernel, cell_id: str) -> StructuredTool:
    def replace_code_cell(code: str, purpose: str, expected_observation: str) -> NotebookCell:
        return kernel.replace_code_cell(cell_id, code, purpose, expected_observation)
    return StructuredTool.from_function(replace_code_cell)
```

- [ ] **Step 4: Implement actor interface changes**

In `actors.py`:

- `Inspector.next_plan(...) -> str` invokes the base chat model without structured output.
- `Reviewer.review_plan(...) -> ReviewerPlanDecision` uses structured output.
- `Reviewer.review_final(...) -> FinalReviewDecision` uses structured output.
- `Coder.append_code_cell(...) -> NotebookCell` binds `append_code_cell`.
- `Debugger.debug_cell(...) -> DebugLesson | None` binds pre-bound replace and lesson tools.

Keep protocols in `orchestrator.py` aligned with these methods in Task 6.

- [ ] **Step 5: Run focused checks**

Run:

```bash
uv run pytest tests/exploration/test_actors.py -q
uv run ruff check src/statigent/exploration/actors.py src/statigent/exploration/tools.py tests/exploration/test_actors.py
uv run mypy src
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/statigent/exploration/actors.py src/statigent/exploration/tools.py tests/exploration/test_actors.py
git commit -m "feat: refactor exploration actors around planning and tools" -m "Make Inspector text-based, keep Reviewer structured, move Coder to append_code_cell tool calls, and constrain Debugger through a replace tool bound to the failed notebook cell."
```

## Task 6: LangGraph Exploration State Graph

**Files:**
- Create: `src/statigent/exploration/state.py`
- Modify: `src/statigent/exploration/orchestrator.py`
- Modify: `src/statigent/exploration/__init__.py`
- Test: `tests/exploration/test_orchestrator.py`

- [ ] **Step 1: Write routing tests**

Replace current single-round assumptions with graph behavior tests:

```python
def test_orchestrator_routes_reviewer_rejection_back_to_inspector(tmp_path: Path) -> None:
    inspector = FakeInspector(plans=["bad plan", "good plan"], final=FinalDraft(content="done"))
    reviewer = FakeReviewer(plan_decisions=[
        ReviewerPlanDecision(approved=False, reason="Redundant"),
        ReviewerPlanDecision(
            approved=True,
            reason="Useful",
            action_kind=ExplorationActionKind.SUMMARIZE_NUMERIC,
            question="What is the mean revenue?",
            evidence_needed="mean revenue",
            coding_instruction="Compute mean revenue.",
        ),
    ])
    kernel = FakeNotebookKernel()
    kernel.queue_result(stdout="mean=15\n")
    kernel.start(NotebookContext(input_paths=[], work_dir=tmp_path / "work"))

    report = make_orchestrator(inspector, reviewer, kernel).run(make_brief(), make_profile(tmp_path))

    assert inspector.plan_calls == 2
    assert report.status == "success"
```

Add separate tests for debug retry, final review loop, and budget exhaustion.

- [ ] **Step 2: Run orchestrator tests and verify failure**

Run:

```bash
uv run pytest tests/exploration/test_orchestrator.py -q
```

Expected: fails because orchestrator is still a linear loop and uses old actor protocols.

- [ ] **Step 3: Add state model**

Create `src/statigent/exploration/state.py`:

```python
class ExplorationRunState(BaseModel):
    brief: TaskBrief
    profile: DatasetProfile
    steps: list[ExplorationStep] = Field(default_factory=list)
    pending_plan_text: str = ""
    review_feedback: str = ""
    approved_instruction: ApprovedCodeInstruction | None = None
    last_cell_id: str = ""
    debug_lessons: list[DebugLesson] = Field(default_factory=list)
    final_draft: FinalDraft | None = None
    final_review: FinalReviewDecision | None = None
    warnings: list[str] = Field(default_factory=list)
    trace_events: list[TraceEvent] = Field(default_factory=list)
    round_count: int = 0
    cell_count: int = 0
    debug_attempts: int = 0
```

Add routing helpers such as `can_continue_exploration(state)`, `can_append_cell(state)`, and `can_debug(state)`.

- [ ] **Step 4: Implement graph nodes**

In `orchestrator.py`, implement node methods:

- `_inspector_plan`
- `_reviewer_review_plan`
- `_coder_append_cell`
- `_execute_cell`
- `_debugger_react`
- `_inspector_observe`
- `_final_draft`
- `_reviewer_review_final`
- `_build_report`

Use `StateGraph(ExplorationRunState)` and conditional edges matching the design spec.

- [ ] **Step 5: Run focused checks**

Run:

```bash
uv run pytest tests/exploration/test_orchestrator.py -q
uv run ruff check src/statigent/exploration tests/exploration/test_orchestrator.py
uv run mypy src
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/statigent/exploration/state.py src/statigent/exploration/orchestrator.py src/statigent/exploration/__init__.py tests/exploration/test_orchestrator.py
git commit -m "feat: implement langgraph exploration orchestrator" -m "Replace the linear exploration loop with a LangGraph state graph covering inspector planning, structured review, coder cell appends, notebook execution, debugger retries, final draft review, budget routing, and partial-output paths."
```

## Task 7: Integration Updates And Architecture Docs

**Files:**
- Modify: `src/statigent/agents/data_science.py`
- Modify: `src/statigent/output/renderer.py`
- Modify: `docs/architecture_zh.md`
- Test: `tests/agents/test_data_science_agent.py`
- Test: `tests/output/test_renderer.py`

- [ ] **Step 1: Write integration smoke tests**

Add a test using fake actors/kernel through `StatigentDataScienceAgent` that returns a successful answer with trace events from `inspector`, `reviewer`, `coder`, and `output_renderer`.

- [ ] **Step 2: Run integration tests and verify failure**

Run:

```bash
uv run pytest tests/agents/test_data_science_agent.py tests/output/test_renderer.py -q
```

Expected: fails until wrapper/output are aligned to the new report and trace shapes.

- [ ] **Step 3: Wire new orchestrator output**

Update `StatigentDataScienceAgent._orchestrator()` construction and `run_analysis_for_eval()` trace assembly so orchestrator trace events are appended before rendering output.

- [ ] **Step 4: Update renderer only if required**

If `ExplorationReport.final_draft` remains compatible, keep `OutputRenderer` unchanged. If final draft variants are added, render direct answers and report text without changing benchmark protocol.

- [ ] **Step 5: Update docs**

Update `docs/architecture_zh.md` sections for:

- `TaskBriefPlanner` explicit parse errors.
- LangGraph exploration layer.
- Reviewer structured output.
- Coder/Debugger tool-bound notebook cell operations.
- Task-local debug lessons.

- [ ] **Step 6: Run focused checks**

Run:

```bash
uv run pytest tests/agents/test_data_science_agent.py tests/output/test_renderer.py -q
uv run ruff check src/statigent/agents src/statigent/output docs tests/agents tests/output
uv run mypy src
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/statigent/agents/data_science.py src/statigent/output/renderer.py docs/architecture_zh.md tests/agents/test_data_science_agent.py tests/output/test_renderer.py
git commit -m "feat: integrate langgraph exploration pipeline" -m "Wire the new exploration graph into the data science agent wrapper, preserve benchmark output compatibility, append orchestrator trace events, and update architecture documentation."
```

## Task 8: Full Verification

**Files:**
- No new files expected.

- [ ] **Step 1: Run full quality gates**

Run:

```bash
uv run ruff check src tests
uv run ruff format src tests
uv run mypy src
uv run pytest
```

Expected:

- Ruff check exits 0.
- Ruff format reports no remaining formatting changes after it runs.
- Mypy exits 0.
- Pytest exits 0.

- [ ] **Step 2: Inspect git diff after formatting**

Run:

```bash
git status --short --branch --ignore-submodules=all
git diff --stat
```

Expected: only intentional formatting changes, if any.

- [ ] **Step 3: Commit verification formatting if needed**

If `uv run ruff format src tests` changed files:

```bash
git add src tests
git commit -m "style: format data exploration graph changes" -m "Apply project formatting after the LangGraph exploration implementation."
```

If no files changed, do not create an empty commit.

## Self-Review

Spec coverage:

- Input planner, parse errors, schema descriptions, and budget tiers are covered by Task 1.
- Trace provenance and analysis entrypoint coercion are covered by Task 2.
- Notebook append, replace, execute-by-id, and code context are covered by Task 3.
- Prompt contracts and exploration schemas are covered by Task 4.
- Inspector text planning, Reviewer structured output, Coder tools, and Debugger tools are covered by Task 5.
- LangGraph state, routing, budgets, final review, and partial output are covered by Task 6.
- Output integration and architecture docs are covered by Task 7.
- Full verification is covered by Task 8.

Placeholder scan:

- This plan contains no deferred implementation markers or incomplete sections.
- Where implementation depends on existing Docker behavior, the plan explicitly says to preserve existing skip behavior and route through stored cells.

Type consistency:

- `ReviewerPlanDecision`, `FinalReviewDecision`, `DebugLesson`, `NotebookCell`, and `NotebookCodeContext` are introduced before they are used by actor and graph tasks.
- Coder and Debugger are tool-driven; Reviewer and Final Reviewer remain structured-output actors.
- The debugger-facing replace tool omits `cell_id`; the kernel-level replace method still accepts `cell_id`.
