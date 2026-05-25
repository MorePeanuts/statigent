"""LangGraph exploration orchestrator for Inspector-led data analysis."""

from typing import Literal, Protocol, cast

from langgraph.graph import END, START, StateGraph

from statigent.exploration.prompts import DEA_ACTION_PROMPTS
from statigent.exploration.state import (
    ExplorationRunState,
    can_append_cell,
    can_continue_exploration,
    can_debug,
)
from statigent.notebook.base import NotebookKernel
from statigent.schemas import (
    ApprovedCodeInstruction,
    CodeDraft,
    DatasetProfile,
    DebugLesson,
    ExplorationAction,
    ExplorationReport,
    ExplorationStep,
    FinalDraft,
    FinalReviewDecision,
    NotebookCell,
    NotebookCellResult,
    ReviewDecision,
    ReviewerPlanDecision,
    TaskBrief,
    TraceEvent,
)


class _CompiledGraph(Protocol):
    def invoke(self, input: ExplorationRunState) -> object: ...


class _Inspector(Protocol):
    def next_plan(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
        reviewer_feedback: str,
    ) -> str: ...

    def final_draft(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
    ) -> FinalDraft: ...


class _Reviewer(Protocol):
    def review_plan(
        self,
        brief: TaskBrief,
        plan_text: str,
    ) -> ReviewerPlanDecision: ...

    def review_final(
        self,
        brief: TaskBrief,
        draft: FinalDraft,
    ) -> FinalReviewDecision: ...


class _Coder(Protocol):
    def append_code_cell(
        self,
        brief: TaskBrief,
        instruction: ApprovedCodeInstruction,
        kernel: NotebookKernel,
    ) -> NotebookCell: ...


class _Debugger(Protocol):
    def debug_cell(
        self,
        brief: TaskBrief,
        kernel: NotebookKernel,
        failed_cell: NotebookCell,
        error: str,
        lessons: list[DebugLesson],
    ) -> list[DebugLesson]: ...


class ExplorationOrchestrator:
    """Runs a LangGraph-backed exploration loop within task budgets."""

    def __init__(
        self,
        *,
        inspector: _Inspector,
        reviewer: _Reviewer,
        coder: _Coder,
        debugger: _Debugger,
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

    def _build_graph(self) -> _CompiledGraph:
        graph = StateGraph(ExplorationRunState)
        graph.add_node("inspector", self._inspector_node)
        graph.add_node("review_plan", self._review_plan_node)
        graph.add_node("code", self._code_node)
        graph.add_node("execute", self._execute_node)
        graph.add_node("debug", self._debug_node)
        graph.add_node("observe", self._observe_node)
        graph.add_node("final_review", self._final_review_node)

        graph.add_edge(START, "inspector")
        graph.add_conditional_edges(
            "inspector",
            self._route_after_inspector,
            {"review_plan": "review_plan", "final_review": "final_review"},
        )
        graph.add_conditional_edges(
            "review_plan",
            self._route_after_plan_review,
            {"inspector": "inspector", "code": "code"},
        )
        graph.add_conditional_edges(
            "code",
            self._route_after_code,
            {"execute": "execute", "final_review": "final_review"},
        )
        graph.add_conditional_edges(
            "execute",
            self._route_after_execute,
            {"debug": "debug", "observe": "observe"},
        )
        graph.add_edge("debug", "execute")
        graph.add_edge("observe", "inspector")
        graph.add_conditional_edges(
            "final_review",
            self._route_after_final_review,
            {"inspector": "inspector", END: END},
        )
        return graph.compile()

    def _inspector_node(
        self,
        state: ExplorationRunState,
    ) -> dict[str, object]:
        if not can_continue_exploration(state):
            if state["steps"]:
                draft = self.inspector.final_draft(
                    state["brief"],
                    state["profile"],
                    state["steps"],
                )
                return {
                    "final_draft": draft,
                    "trace_events": [
                        *state["trace_events"],
                        self._trace(
                            "inspector",
                            "final_draft",
                            draft.model_dump_json(),
                            usage_metadata=self._actor_usage(self.inspector),
                            metadata={
                                "reason": (
                                    "Round budget reached after completed "
                                    "exploration."
                                )
                            },
                        ),
                    ],
                }
            return self._budget_draft_update(state, "Round budget exhausted.")

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
        if self._is_stop_plan(plan_text):
            draft = self.inspector.final_draft(
                state["brief"],
                state["profile"],
                state["steps"],
            )
            updates["final_draft"] = draft
            updates["trace_events"] = [
                *cast("list[TraceEvent]", updates["trace_events"]),
                self._trace(
                    "inspector",
                    "final_draft",
                    draft.model_dump_json(),
                    usage_metadata=self._actor_usage(self.inspector),
                    metadata={"reason": "Inspector stopped."},
                ),
            ]
        return updates

    def _review_plan_node(
        self,
        state: ExplorationRunState,
    ) -> dict[str, object]:
        decision = self.reviewer.review_plan(
            state["brief"],
            state["pending_plan_text"],
        )
        if not decision.approved:
            return {
                "plan_review": decision,
                "review_feedback": decision.reason,
                "warnings": [
                    *state["warnings"],
                    f"Reviewer rejected plan: {decision.reason}",
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
            }

        if decision.action_kind is None:
            return {
                "plan_review": decision,
                "review_feedback": "Approved plan did not include an action kind.",
                "warnings": [
                    *state["warnings"],
                    "Reviewer approved a plan without an action kind.",
                ],
                "trace_events": [
                    *state["trace_events"],
                    self._trace(
                        "reviewer",
                        "plan_approved_missing_action",
                        decision.model_dump_json(),
                        usage_metadata=self._actor_usage(self.reviewer),
                        metadata={"plan_text": state["pending_plan_text"]},
                    ),
                ],
            }

        instruction = ApprovedCodeInstruction(
            action_kind=decision.action_kind,
            question=decision.question,
            evidence_needed=decision.evidence_needed,
            coding_instruction=decision.coding_instruction,
            action_prompt=DEA_ACTION_PROMPTS[decision.action_kind],
            rationale=decision.reason,
            risk_notes=decision.risk_notes,
            constraints=decision.constraints,
        )
        return {
            "plan_review": decision,
            "approved_instruction": instruction,
            "review_feedback": "",
            "trace_events": [
                *state["trace_events"],
                self._trace(
                    "reviewer",
                    "plan_approved",
                    decision.model_dump_json(),
                    usage_metadata=self._actor_usage(self.reviewer),
                    metadata={
                        "plan_text": state["pending_plan_text"],
                        "approved_instruction": instruction.model_dump(mode="json"),
                    },
                ),
            ],
        }

    def _code_node(self, state: ExplorationRunState) -> dict[str, object]:
        instruction = state["approved_instruction"]
        if instruction is None:
            return {
                "warnings": [
                    *state["warnings"],
                    "Coder skipped because no approved instruction was available.",
                ],
                "final_draft": self._partial_draft(state),
                "status": "partial",
            }
        if not can_append_cell(state):
            return self._budget_draft_update(state, "Code cell budget exhausted.")

        cell = self.coder.append_code_cell(
            state["brief"],
            instruction,
            self.kernel,
        )
        return {
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
                    metadata=self._cell_trace_metadata(cell),
                ),
            ],
        }

    def _execute_node(self, state: ExplorationRunState) -> dict[str, object]:
        result = self.kernel.execute_cell(state["last_cell_id"])
        return {
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
        }

    def _debug_node(self, state: ExplorationRunState) -> dict[str, object]:
        failed_cell = state.get("last_cell")
        result = state.get("last_result")
        if failed_cell is None or result is None:
            return {
                "warnings": [
                    *state["warnings"],
                    "Debugger skipped because failed cell context was missing.",
                ],
            }
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
        return {
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
        }

    def _observe_node(self, state: ExplorationRunState) -> dict[str, object]:
        instruction = state["approved_instruction"]
        cell = state.get("last_cell")
        result = state.get("last_result")
        if instruction is None or cell is None or result is None:
            return {
                "warnings": [
                    *state["warnings"],
                    "Exploration step could not be recorded due to missing state.",
                ],
                "debug_attempts": 0,
            }

        action = ExplorationAction(
            kind=instruction.action_kind,
            title=instruction.question,
            description=instruction.coding_instruction,
            rationale=instruction.rationale,
            expected_evidence=instruction.evidence_needed,
            risk_notes=instruction.risk_notes,
        )
        plan_review = state.get("plan_review")
        review = ReviewDecision(
            approved=True,
            reason=plan_review.reason if plan_review is not None else "Approved",
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
        return {
            "steps": [*state["steps"], step],
            "warnings": warnings,
            "approved_instruction": None,
            "last_cell": None,
            "last_cell_id": "",
            "last_result": None,
            "debug_attempts": 0,
            "status": status,
            "trace_events": [
                *state["trace_events"],
                self._trace("orchestrator", "observe", action.title),
            ],
        }

    def _final_review_node(
        self,
        state: ExplorationRunState,
    ) -> dict[str, object]:
        draft = state["final_draft"] or self.inspector.final_draft(
            state["brief"],
            state["profile"],
            state["steps"],
        )
        decision = self.reviewer.review_final(state["brief"], draft)
        if decision.approved:
            return {
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
            }

        feedback = decision.additional_exploration_focus or decision.reason
        updates: dict[str, object] = {
            "final_draft": draft,
            "final_review": decision,
            "review_feedback": feedback,
            "warnings": [
                *state["warnings"],
                f"Final review did not approve the draft: {decision.reason}",
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
        else:
            updates["final_draft"] = None
        return updates

    def _route_after_inspector(self, state: ExplorationRunState) -> str:
        if state["final_draft"] is not None:
            return "final_review"
        return "review_plan"

    def _route_after_plan_review(self, state: ExplorationRunState) -> str:
        decision = state.get("plan_review")
        if (
            decision is not None
            and decision.approved
            and state["approved_instruction"] is not None
        ):
            return "code"
        return "inspector"

    def _route_after_code(self, state: ExplorationRunState) -> str:
        if state["final_draft"] is not None:
            return "final_review"
        return "execute"

    def _route_after_execute(self, state: ExplorationRunState) -> str:
        result = state.get("last_result")
        if result is not None and not result.ok and can_debug(state):
            return "debug"
        return "observe"

    def _route_after_final_review(self, state: ExplorationRunState) -> str:
        review = state["final_review"]
        if review is not None and review.approved:
            return END
        if can_continue_exploration(state):
            return "inspector"
        return END

    def _budget_draft_update(
        self,
        state: ExplorationRunState,
        warning: str,
    ) -> dict[str, object]:
        return {
            "final_draft": self._partial_draft(state),
            "warnings": [*state["warnings"], warning],
            "status": "partial",
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
    def _is_stop_plan(plan_text: str) -> bool:
        for line in plan_text.splitlines():
            label, separator, value = line.partition(":")
            if separator and label.strip().casefold() == "stop":
                return value.strip().casefold() == "yes"
        return False

    @staticmethod
    def _empty_draft(content: str) -> FinalDraft:
        return FinalDraft(content=content)

    @staticmethod
    @staticmethod
    def _cell_trace_metadata(cell: NotebookCell) -> dict[str, object]:
        return {
            "cell_id": cell.cell_id,
            "code": cell.code,
            "purpose": cell.purpose,
            "expected_observation": cell.expected_observation,
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
