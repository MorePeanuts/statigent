"""LangGraph exploration orchestrator for Inspector-led data analysis."""

from typing import Literal, cast

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from statigent.errors import StatigentExplorationError, StatigentParseError
from statigent.exploration.actors import Coder, Debugger, Inspector
from statigent.exploration.state import (
    ExplorationRunState,
    can_append_cell,
    can_continue_exploration,
    can_debug,
)
from statigent.notebook.base import NotebookKernel
from statigent.schemas import (
    CodeDraft,
    DatasetProfile,
    ExplorationAction,
    ExplorationReport,
    ExplorationStep,
    FinalDraft,
    NotebookCell,
    NotebookCellResult,
    ReviewDecision,
    TaskBrief,
    TraceEvent,
)


class ExplorationOrchestrator:
    """Runs a LangGraph-backed exploration loop within task budgets."""

    def __init__(
        self,
        *,
        inspector: Inspector,
        coder: Coder,
        debugger: Debugger,
        kernel: NotebookKernel,
    ) -> None:
        self.inspector = inspector
        self.coder = coder
        self.debugger = debugger
        self.kernel = kernel
        self._graph = self._build_graph()

    def run(self, brief: TaskBrief, profile: DatasetProfile) -> ExplorationReport:
        initial_state: ExplorationRunState = {
            "brief": brief,
            "profile": profile,
            "steps": [],
            "pending_plan_text": "",
            "approved_instruction": None,
            "last_cell_id": "",
            "debug_lessons": [],
            "final_draft_requested": False,
            "final_draft": None,
            "warnings": [],
            "trace_events": [],
            "round_count": 0,
            "cell_count": 0,
            "debug_attempts": 0,
            "last_cell": None,
            "last_result": None,
            "status": "",
        }
        final_state = cast(
            "ExplorationRunState",
            self._graph.invoke(initial_state),
        )
        draft = final_state["final_draft"] or self._empty_draft(
            "No exploration draft was produced."
        )
        status = self._report_status(final_state)
        return ExplorationReport(
            status=status,
            final_draft=draft,
            steps=final_state["steps"],
            artifacts=self.kernel.list_artifacts(),
            warnings=[*final_state["warnings"], *draft.warnings],
            trace_events=final_state["trace_events"],
        )

    def close(self) -> None:
        """Release resources owned by the underlying notebook kernel."""
        self.kernel.close()

    def _build_graph(
        self,
    ) -> CompiledStateGraph[
        ExplorationRunState,
        None,
        ExplorationRunState,
        ExplorationRunState,
    ]:
        graph = StateGraph(ExplorationRunState)
        graph.add_node("inspector", self._inspector_node)
        graph.add_node("code", self._code_node)
        graph.add_node("debug", self._debug_node)

        graph.add_edge(START, "inspector")
        return graph.compile()

    def _inspector_node(
        self,
        state: ExplorationRunState,
    ) -> Command[str]:
        if state["final_draft_requested"]:
            return self._command(
                self._final_draft_update(
                    state,
                    "Inspector found sufficient evidence for final drafting.",
                ),
                END,
            )

        if not can_continue_exploration(state):
            if state["steps"]:
                return self._command(
                    self._final_draft_update(
                        state,
                        "Round budget reached after completed exploration.",
                    ),
                    END,
                )
            return self._command(
                self._budget_draft_update(state, "Round budget exhausted."),
                END,
            )

        plan_text = self.inspector.next_plan(
            state["brief"],
            state["profile"],
            state["steps"],
        )
        updates: dict[str, object] = {
            "pending_plan_text": plan_text,
            "round_count": state["round_count"] + 1,
            "trace_events": [
                *state["trace_events"],
                self._trace(
                    "inspector",
                    "plan",
                    plan_text,
                    usage_metadata=self._actor_usage(self.inspector),
                ),
            ],
        }
        return self._command(
            self._inspector_plan_update(state, plan_text, updates),
            self._inspector_plan_goto(plan_text),
        )

    def _code_node(self, state: ExplorationRunState) -> Command[str]:
        instruction = state["approved_instruction"]
        if instruction is None:
            return self._command(
                {
                    "warnings": [
                        *state["warnings"],
                        "Coder skipped because no approved instruction was available.",
                    ],
                    "final_draft": self._partial_draft(state),
                    "status": "partial",
                },
                END,
            )
        if not can_append_cell(state):
            return self._command(
                self._budget_draft_update(state, "Code cell budget exhausted."),
                END,
            )

        try:
            outcome = self.coder.append_and_execute(
                state["profile"],
                instruction,
            )
        except StatigentExplorationError as err:
            warning = f"Coder failed to execute approved instruction: {err}"
            return self._command(
                {
                    "warnings": [*state["warnings"], warning],
                    "approved_instruction": None,
                    "final_draft": self._partial_draft(state),
                    "status": "partial",
                    "trace_events": [
                        *state["trace_events"],
                        self._trace(
                            "coder",
                            "protocol_error",
                            str(err),
                            usage_metadata=self._actor_usage(self.coder),
                            metadata={"approved_instruction": instruction},
                        ),
                    ],
                },
                END,
            )
        cell = outcome.cell
        result = outcome.result
        trace_events = [
            *state["trace_events"],
            self._trace(
                "coder",
                "append_code_cell",
                cell.code,
                usage_metadata=self._actor_usage(self.coder),
                metadata=self._code_cell_trace_metadata(cell),
            ),
            self._trace(
                "coder",
                "observation",
                outcome.observation,
                metadata=result.model_dump(mode="json"),
            ),
        ]
        updates: dict[str, object] = {
            "last_cell": cell,
            "last_cell_id": cell.cell_id,
            "last_result": result,
            "cell_count": state["cell_count"] + 1,
            "trace_events": trace_events,
        }
        if not result.ok and can_debug(state):
            return self._command(updates, "debug")
        step_update = self._record_step_update(state, cell, result, trace_events)
        step_update["cell_count"] = state["cell_count"] + 1
        return self._command(step_update, "inspector")

    def _debug_node(self, state: ExplorationRunState) -> Command[str]:
        failed_cell = state.get("last_cell")
        result = state.get("last_result")
        if failed_cell is None or result is None:
            return self._command(
                {
                    "warnings": [
                        *state["warnings"],
                        "Debugger skipped because failed cell context was missing.",
                    ],
                },
                "inspector",
            )
        error = result.error_summary or result.stderr
        lesson_snapshot = list(state["debug_lessons"])
        outcome = self.debugger.debug_cell(
            state["brief"],
            self.kernel,
            failed_cell,
            error,
            lesson_snapshot,
        )
        updated_cell = outcome.cell
        updated_result = outcome.result
        debug_attempts = state["debug_attempts"] + 1
        trace_events = [
            *state["trace_events"],
            self._trace(
                "debugger",
                "debug_cell",
                updated_cell.code,
                usage_metadata=self._actor_usage(self.debugger),
                metadata={
                    "cell_id": failed_cell.cell_id,
                    "failed_code": failed_cell.code,
                    "corrected_code": updated_cell.code,
                    "purpose": updated_cell.purpose,
                    "expected_observation": updated_cell.expected_observation,
                    "error": error,
                    "lessons": [
                        lesson.model_dump(mode="json") for lesson in outcome.lessons
                    ],
                },
            ),
            self._trace(
                "coder",
                "observation",
                self.coder.observation_for_result(
                    state["approved_instruction"] or "",
                    updated_cell,
                    updated_result,
                ),
                metadata=updated_result.model_dump(mode="json"),
            ),
        ]
        updates: dict[str, object] = {
            "debug_attempts": debug_attempts,
            "debug_lessons": list(outcome.lessons),
            "last_cell": updated_cell,
            "last_result": updated_result,
            "trace_events": trace_events,
        }
        debug_state = state.copy()
        debug_state["debug_attempts"] = debug_attempts
        if not updated_result.ok and can_debug(debug_state):
            return self._command(updates, "debug")
        return self._command(
            self._record_step_update(
                state,
                updated_cell,
                updated_result,
                trace_events,
                debug_attempts=debug_attempts,
                debug_lessons=list(outcome.lessons),
            ),
            "inspector",
        )

    def _record_step_update(
        self,
        state: ExplorationRunState,
        cell: NotebookCell,
        result: NotebookCellResult,
        trace_events: list[TraceEvent],
        *,
        debug_attempts: int | None = None,
        debug_lessons: list[object] | None = None,
    ) -> dict[str, object]:
        action = self._action_from_plan_text(state["pending_plan_text"])
        review = ReviewDecision(
            approved=True,
            reason="Directed by Inspector",
        )
        code = CodeDraft(
            code=cell.code,
            purpose=cell.purpose,
            expected_observation=cell.expected_observation,
        )
        warnings = list(state["warnings"])
        status = state.get("status", "")
        if not result.ok:
            error = result.error_summary or result.stderr
            warnings.append(f"Exploration cell failed: {error}")
            warnings.append("Debug budget exhausted.")
            status = "partial"
        step = ExplorationStep(
            action=action,
            review=review,
            code=code,
            result=result,
            debug_attempts=(
                state["debug_attempts"] if debug_attempts is None else debug_attempts
            ),
        )
        updates: dict[str, object] = {
            "steps": [*state["steps"], step],
            "warnings": warnings,
            "approved_instruction": None,
            "last_cell": None,
            "last_cell_id": "",
            "last_result": None,
            "debug_attempts": 0,
            "status": status,
            "final_draft_requested": False,
            "trace_events": trace_events,
        }
        if debug_lessons is not None:
            updates["debug_lessons"] = debug_lessons
        return updates

    def _budget_draft_update(
        self,
        state: ExplorationRunState,
        warning: str,
    ) -> dict[str, object]:
        return {
            "final_draft": self._partial_draft(state),
            "final_draft_requested": False,
            "warnings": [*state["warnings"], warning],
            "status": "partial",
        }

    def _inspector_plan_update(
        self,
        state: ExplorationRunState,
        plan_text: str,
        base_updates: dict[str, object],
    ) -> dict[str, object]:
        instruction = self._coder_instruction_from_plan_text(plan_text)
        if self._plan_requests_done(plan_text) and instruction:
            warning = "DONE ignored because CODER_INSTRUCTION is not empty."
            return {
                **base_updates,
                "approved_instruction": instruction,
                "warnings": [*state["warnings"], warning],
                "final_draft_requested": False,
            }

        if self._plan_requests_done(plan_text):
            return {
                **base_updates,
                "final_draft_requested": True,
            }

        if not instruction:
            warning = "Inspector did not provide CODER_INSTRUCTION."
            return {
                **base_updates,
                "warnings": [*state["warnings"], warning],
                "final_draft_requested": False,
            }

        return {
            **base_updates,
            "approved_instruction": instruction,
            "final_draft_requested": False,
        }

    def _inspector_plan_goto(self, plan_text: str) -> str:
        instruction = self._coder_instruction_from_plan_text(plan_text)
        if self._plan_requests_done(plan_text) and not instruction:
            return "inspector"
        if instruction:
            return "code"
        return "inspector"

    @staticmethod
    def _command(update: dict[str, object], goto: str) -> Command[str]:
        return Command(update=update, goto=goto)

    def _final_draft_update(
        self,
        state: ExplorationRunState,
        reason: str,
    ) -> dict[str, object]:
        draft, error = self._draft_with_fallback(state)
        trace_events = [
            *state["trace_events"],
            self._trace(
                "inspector",
                "final_draft" if error is None else "protocol_error",
                draft.model_dump_json() if error is None else str(error),
                usage_metadata=self._actor_usage(self.inspector),
                metadata={"reason": reason},
            ),
        ]
        update: dict[str, object] = {
            "final_draft": draft,
            "final_draft_requested": False,
            "trace_events": trace_events,
        }
        if error is not None:
            update["status"] = "partial"
        return update

    def _partial_draft(self, state: ExplorationRunState) -> FinalDraft:
        if state["steps"]:
            draft, _ = self._draft_with_fallback(state)
            return draft
        return self._empty_draft("No exploration steps were completed.")

    def _draft_with_fallback(
        self,
        state: ExplorationRunState,
    ) -> tuple[FinalDraft, StatigentParseError | None]:
        try:
            return (
                self.inspector.final_draft(
                    state["brief"],
                    state["profile"],
                    state["steps"],
                ),
                None,
            )
        except StatigentParseError as err:
            warning = f"Inspector failed to produce final draft: {err}"
            evidence = [
                output
                for step in state["steps"]
                if step.result is not None
                and (output := step.result.stdout.strip())
            ]
            content = evidence[-1] if evidence else "No final draft was produced."
            return (
                FinalDraft(
                    content=content,
                    evidence=evidence,
                    warnings=[warning],
                ),
                err,
            )

    def _report_status(
        self,
        state: ExplorationRunState,
    ) -> Literal["success", "partial"]:
        if state.get("status") == "partial":
            return "partial"
        return "success" if state["final_draft"] is not None else "partial"

    def _find_cell(self, cell_id: str) -> NotebookCell | None:
        for cell in self.kernel.get_code_context().cells:
            if cell.cell_id == cell_id:
                return cell
        return None

    @staticmethod
    def _action_from_plan_text(plan_text: str) -> ExplorationAction:
        fields: dict[str, str] = {}
        for line in plan_text.splitlines():
            label, separator, value = line.partition(":")
            if separator:
                fields[label.strip().casefold()] = value.strip()
        action_label = fields.get("action", "Inspector plan")
        return ExplorationAction(
            title=fields.get("question") or action_label,
            description=plan_text,
            rationale="Inspector-directed exploration",
            expected_evidence=fields.get("evidence_needed", ""),
            risk_notes="",
        )

    @classmethod
    def _plan_requests_done(cls, plan_text: str) -> bool:
        return any(line.strip().casefold() == "done" for line in plan_text.splitlines())

    @classmethod
    def _coder_instruction_from_plan_text(cls, plan_text: str) -> str:
        return cls._plan_field(plan_text, "coder_instruction")

    @staticmethod
    def _plan_field(plan_text: str, key: str) -> str:
        for line in plan_text.splitlines():
            label, separator, value = line.partition(":")
            if separator and label.strip().casefold() == key:
                return value.strip()
        return ""

    @staticmethod
    def _empty_draft(content: str) -> FinalDraft:
        return FinalDraft(content=content)

    @staticmethod
    def _cell_trace_metadata(cell: NotebookCell) -> dict[str, object]:
        return {
            "cell_id": cell.cell_id,
            "code": cell.code,
            "purpose": cell.purpose,
            "expected_observation": cell.expected_observation,
        }

    def _code_cell_trace_metadata(self, cell: NotebookCell) -> dict[str, object]:
        return {
            **self._cell_trace_metadata(cell),
            "input_paths": [str(path) for path in self.kernel.list_inputs()],
        }

    @staticmethod
    def _result_trace_content(result: NotebookCellResult) -> str:
        if result.ok:
            return result.stdout
        return result.error_summary or result.stderr

    @staticmethod
    def _actor_usage(actor: object) -> dict[str, int]:
        usage = getattr(actor, "last_usage_metadata", {})
        if not isinstance(usage, dict):
            return {}
        normalized: dict[str, int] = {}
        for key in ("input_tokens", "output_tokens", "total_tokens"):
            value = usage.get(key)
            if isinstance(value, int):
                normalized[key] = value
        return normalized

    @staticmethod
    def _trace(
        agent: str,
        name: str,
        content: str,
        *,
        usage_metadata: dict[str, int] | None = None,
        metadata: dict[str, object] | None = None,
    ) -> TraceEvent:
        return TraceEvent(
            role="assistant",
            content=content,
            name=name,
            agent=agent,
            usage_metadata=usage_metadata or {},
            metadata=metadata or {},
        )
