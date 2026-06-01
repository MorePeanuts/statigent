"""LangGraph exploration orchestrator for Inspector-led data analysis."""

from typing import Literal, cast

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from statigent.exploration.actors import Coder, Debugger, Inspector, Reviewer
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
        reviewer: Reviewer,
        coder: Coder,
        debugger: Debugger,
        kernel: NotebookKernel,
    ) -> None:
        self.inspector = inspector
        self.reviewer = reviewer
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
            "review_feedback": "",
            "approved_instruction": None,
            "last_cell_id": "",
            "debug_lessons": [],
            "final_draft_requested": False,
            "final_draft": None,
            "final_review": None,
            "warnings": [],
            "trace_events": [],
            "round_count": 0,
            "cell_count": 0,
            "debug_attempts": 0,
            "plan_review": None,
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
        graph.add_node("review_plan", self._review_plan_node)
        graph.add_node("code", self._code_node)
        graph.add_node("execute", self._execute_node)
        graph.add_node("debug", self._debug_node)
        graph.add_node("observe", self._observe_node)
        graph.add_node("final_review", self._final_review_node)

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
                    "Reviewer approved final drafting.",
                ),
                "final_review",
            )

        if not can_continue_exploration(state):
            if state["steps"]:
                return self._command(
                    self._final_draft_update(
                        state,
                        "Round budget reached after completed exploration.",
                    ),
                    "final_review",
                )
            return self._command(
                self._budget_draft_update(state, "Round budget exhausted."),
                "final_review",
            )

        plan_text = self.inspector.next_plan(
            state["brief"],
            state["profile"],
            state["steps"],
            state["review_feedback"],
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
        return self._command(updates, "review_plan")

    def _review_plan_node(
        self,
        state: ExplorationRunState,
    ) -> Command[str]:
        decision = self.reviewer.review_plan(
            state["brief"],
            state["profile"],
            state["steps"],
            state["pending_plan_text"],
        )
        if not decision.approved and not decision.approved_final:
            feedback = decision.feedback or "Reviewer rejected the Inspector plan."
            return self._command(
                {
                    "plan_review": decision,
                    "review_feedback": feedback,
                    "final_draft_requested": False,
                    "warnings": [
                        *state["warnings"],
                        f"Reviewer rejected plan: {feedback}",
                    ],
                    "trace_events": [
                        *state["trace_events"],
                        self._trace(
                            "reviewer",
                            "plan_rejected",
                            decision.model_dump_json(),
                            usage_metadata=self._actor_usage(self.reviewer),
                            metadata={"plan_text": state["pending_plan_text"]},
                        ),
                    ],
                },
                "inspector",
            )

        if decision.approved_final:
            if not state["steps"]:
                feedback = (
                    "Reviewer approved final drafting before any executed "
                    "exploration evidence was available."
                )
                return self._command(
                    {
                        "plan_review": decision,
                        "review_feedback": feedback,
                        "final_draft_requested": False,
                        "warnings": [
                            *state["warnings"],
                            (
                                "Reviewer approved final drafting without "
                                "executed evidence."
                            ),
                        ],
                        "trace_events": [
                            *state["trace_events"],
                            self._trace(
                                "reviewer",
                                "final_approved_without_evidence",
                                decision.model_dump_json(),
                                usage_metadata=self._actor_usage(self.reviewer),
                                metadata={"plan_text": state["pending_plan_text"]},
                            ),
                        ],
                    },
                    "inspector",
                )
            return self._command(
                {
                    "plan_review": decision,
                    "review_feedback": "",
                    "final_draft_requested": True,
                    "trace_events": [
                        *state["trace_events"],
                        self._trace(
                            "reviewer",
                            "final_approved",
                            decision.model_dump_json(),
                            usage_metadata=self._actor_usage(self.reviewer),
                            metadata={"plan_text": state["pending_plan_text"]},
                        ),
                    ],
                },
                "inspector",
            )

        if not decision.approved:
            feedback = "Reviewer did not approve exploration or final drafting."
            return self._command(
                {
                    "plan_review": decision,
                    "review_feedback": feedback,
                    "final_draft_requested": False,
                    "warnings": [
                        *state["warnings"],
                        feedback,
                    ],
                    "trace_events": [
                        *state["trace_events"],
                        self._trace(
                            "reviewer",
                            "plan_not_approved",
                            decision.model_dump_json(),
                            usage_metadata=self._actor_usage(self.reviewer),
                            metadata={"plan_text": state["pending_plan_text"]},
                        ),
                    ],
                },
                "inspector",
            )

        instruction = decision.coder_instruction
        return self._command(
            {
                "plan_review": decision,
                "approved_instruction": instruction,
                "review_feedback": "",
                "final_draft_requested": False,
                "trace_events": [
                    *state["trace_events"],
                    self._trace(
                        "reviewer",
                        "plan_approved",
                        decision.model_dump_json(),
                        usage_metadata=self._actor_usage(self.reviewer),
                        metadata={
                            "plan_text": state["pending_plan_text"],
                            "approved_instruction": instruction,
                        },
                    ),
                ],
            },
            "code",
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
                "final_review",
            )
        if not can_append_cell(state):
            return self._command(
                self._budget_draft_update(state, "Code cell budget exhausted."),
                "final_review",
            )

        cell = self.coder.append_code_cell(
            state["profile"],
            instruction,
            self.kernel,
        )
        return self._command(
            {
                "last_cell": cell,
                "last_cell_id": cell.cell_id,
                "cell_count": state["cell_count"] + 1,
                "trace_events": [
                    *state["trace_events"],
                    self._trace(
                        "coder",
                        "append_code_cell",
                        cell.code,
                        usage_metadata=self._actor_usage(self.coder),
                        metadata=self._code_cell_trace_metadata(cell),
                    ),
                ],
            },
            "execute",
        )

    def _execute_node(self, state: ExplorationRunState) -> Command[str]:
        result = self.kernel.execute_cell(state["last_cell_id"])
        goto = "debug" if not result.ok and can_debug(state) else "observe"
        return self._command(
            {
                "last_result": result,
                "trace_events": [
                    *state["trace_events"],
                    self._trace(
                        "executor",
                        "execute_cell",
                        self._result_trace_content(result),
                        metadata=result.model_dump(mode="json"),
                    ),
                ],
            },
            goto,
        )

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
                "execute",
            )
        error = result.error_summary or result.stderr
        lesson_snapshot = list(state["debug_lessons"])
        lessons = self.debugger.debug_cell(
            state["brief"],
            self.kernel,
            failed_cell,
            error,
            lesson_snapshot,
        )
        updated_cell = self._find_cell(failed_cell.cell_id) or failed_cell
        return self._command(
            {
                "debug_attempts": state["debug_attempts"] + 1,
                "debug_lessons": list(lessons),
                "last_cell": updated_cell,
                "trace_events": [
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
                                lesson.model_dump(mode="json") for lesson in lessons
                            ],
                        },
                    ),
                ],
            },
            "execute",
        )

    def _observe_node(self, state: ExplorationRunState) -> Command[str]:
        instruction = state["approved_instruction"]
        cell = state.get("last_cell")
        result = state.get("last_result")
        if instruction is None or cell is None or result is None:
            return self._command(
                {
                    "warnings": [
                        *state["warnings"],
                        "Exploration step could not be recorded due to missing state.",
                    ],
                    "debug_attempts": 0,
                },
                "inspector",
            )

        action = self._action_from_plan_text(state["pending_plan_text"])
        plan_review = state.get("plan_review")
        review = ReviewDecision(
            approved=True,
            reason="Approved by Reviewer" if plan_review is not None else "Approved",
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
            if not can_debug(state):
                warnings.append("Debug budget exhausted.")
                status = "partial"
        step = ExplorationStep(
            action=action,
            review=review,
            code=code,
            result=result,
            debug_attempts=state["debug_attempts"],
        )
        return self._command(
            {
                "steps": [*state["steps"], step],
                "warnings": warnings,
                "approved_instruction": None,
                "last_cell": None,
                "last_cell_id": "",
                "last_result": None,
                "debug_attempts": 0,
                "status": status,
                "final_draft_requested": False,
                "trace_events": [
                    *state["trace_events"],
                    self._trace("orchestrator", "observe", action.title),
                ],
            },
            "inspector",
        )

    def _final_review_node(
        self,
        state: ExplorationRunState,
    ) -> Command[str]:
        draft = state["final_draft"] or self.inspector.final_draft(
            state["brief"],
            state["profile"],
            state["steps"],
        )
        decision = self.reviewer.review_final(state["brief"], state["steps"], draft)
        if decision.approved:
            return self._command(
                {
                    "final_draft": draft,
                    "final_review": decision,
                    "trace_events": [
                        *state["trace_events"],
                        self._trace(
                            "final_reviewer",
                            "approved",
                            decision.model_dump_json(),
                            usage_metadata=self._actor_usage(self.reviewer),
                            metadata={"draft": draft.model_dump(mode="json")},
                        ),
                    ],
                },
                END,
            )

        feedback = decision.feedback or "Final review rejected the draft."
        updates: dict[str, object] = {
            "final_draft": draft,
            "final_review": decision,
            "review_feedback": feedback,
            "warnings": [
                *state["warnings"],
                f"Final review did not approve the draft: {feedback}",
            ],
            "trace_events": [
                *state["trace_events"],
                self._trace(
                    "final_reviewer",
                    "rejected",
                    decision.model_dump_json(),
                    usage_metadata=self._actor_usage(self.reviewer),
                    metadata={"draft": draft.model_dump(mode="json")},
                ),
            ],
        }
        if not can_continue_exploration(state):
            updates["status"] = "partial"
            goto = END
        else:
            updates["final_draft"] = None
            updates["final_draft_requested"] = False
            goto = "inspector"
        return self._command(updates, goto)

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

    @staticmethod
    def _command(update: dict[str, object], goto: str) -> Command[str]:
        return Command(update=update, goto=goto)

    def _final_draft_update(
        self,
        state: ExplorationRunState,
        reason: str,
    ) -> dict[str, object]:
        draft = self.inspector.final_draft(
            state["brief"],
            state["profile"],
            state["steps"],
        )
        return {
            "final_draft": draft,
            "final_draft_requested": False,
            "trace_events": [
                *state["trace_events"],
                self._trace(
                    "inspector",
                    "final_draft",
                    draft.model_dump_json(),
                    usage_metadata=self._actor_usage(self.inspector),
                    metadata={"reason": reason},
                ),
            ],
        }

    def _partial_draft(self, state: ExplorationRunState) -> FinalDraft:
        if state["steps"]:
            return self.inspector.final_draft(
                state["brief"],
                state["profile"],
                state["steps"],
            )
        return self._empty_draft("No exploration steps were completed.")

    def _report_status(
        self,
        state: ExplorationRunState,
    ) -> Literal["success", "partial"]:
        if state.get("status") == "partial":
            return "partial"
        review = state["final_review"]
        if review is None or not review.approved:
            return "partial"
        return "success"

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
            rationale="Approved Inspector plan",
            expected_evidence=fields.get("evidence_needed", ""),
            risk_notes="Reviewer did not provide separate risk notes.",
        )

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
