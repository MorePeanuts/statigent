"""Explicit exploration loop orchestrating Inspector, Reviewer, Coder, and Debugger.

The orchestrator iterates through: Inspector proposes action &rarr; Reviewer
approves/rejects/revises &rarr; Coder writes code &rarr; Kernel executes &rarr;
Debugger fixes failures (up to max_debug_attempts). Budgets (max_rounds,
max_code_cells) are enforced throughout. Currently single-round skeleton.
"""

from typing import Literal, Protocol

from statigent.notebook.base import NotebookKernel
from statigent.schemas import (
    CodeDraft,
    DatasetProfile,
    DebugDecision,
    ExplorationAction,
    ExplorationReport,
    ExplorationStep,
    FinalDraft,
    ReviewDecision,
    TaskBrief,
)


class _Inspector(Protocol):
    def next_action(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
        reviewer_feedback: str,
    ) -> ExplorationAction: ...

    def final_draft(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        steps: list[ExplorationStep],
    ) -> FinalDraft: ...


class _Reviewer(Protocol):
    def review_action(
        self,
        brief: TaskBrief,
        action: ExplorationAction,
    ) -> ReviewDecision: ...

    def review_final(self, brief: TaskBrief, draft: FinalDraft) -> ReviewDecision: ...


class _Coder(Protocol):
    def write_code(self, brief: TaskBrief, action: ExplorationAction) -> CodeDraft: ...


class _Debugger(Protocol):
    def debug(self, brief: TaskBrief, code: str, error: str) -> DebugDecision: ...


class ExplorationOrchestrator:
    """Runs the Inspector-Reviewer-Coder-Debugger loop within budget limits.

    Accepts fake or real actors and kernel via dependency injection so
    the same loop works for both tests and production.
    """

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

    def run(self, brief: TaskBrief, profile: DatasetProfile) -> ExplorationReport:
        steps: list[ExplorationStep] = []
        warnings: list[str] = []
        reviewer_feedback = ""

        for _round in range(brief.budgets.max_rounds):
            completed_code_cells = sum(1 for step in steps if step.code is not None)
            if completed_code_cells >= brief.budgets.max_code_cells:
                warnings.append("Code cell budget exhausted.")
                break

            action = self.inspector.next_action(
                brief,
                profile,
                steps,
                reviewer_feedback,
            )
            review = self.reviewer.review_action(brief, action)
            if not review.approved:
                reviewer_feedback = review.reason
                warnings.append(f"Reviewer rejected action: {review.reason}")
                continue

            approved_action = review.revised_action or action
            code = self.coder.write_code(brief, approved_action)
            result = self.kernel.execute_cell(code.code, code.purpose)
            debug_attempts = 0

            while not result.ok and debug_attempts < brief.budgets.max_debug_attempts:
                debug_attempts += 1
                decision = self.debugger.debug(
                    brief,
                    result.code,
                    result.error_summary or result.stderr,
                )
                if not decision.retry:
                    warnings.append(f"Debugger abandoned action: {decision.reason}")
                    break
                result = self.kernel.execute_cell(decision.code, code.purpose)

            if not result.ok:
                warnings.append(f"Exploration action failed: {approved_action.title}")

            steps.append(
                ExplorationStep(
                    action=approved_action,
                    review=review,
                    code=code,
                    result=result,
                    debug_attempts=debug_attempts,
                )
            )
            # WARNING: orchestrator loop currently runs only 1 round;
            # multi-round iteration (Inspector re-proposes after reviewer
            # feedback, accumulated results guide next actions) is not
            # yet implemented.
            break

        if steps:
            draft = self.inspector.final_draft(brief, profile, steps)
        else:
            draft = FinalDraft(
                content="No exploration steps were completed.",
                warnings=["No approved exploration action completed."],
            )

        final_review = self.reviewer.review_final(brief, draft)
        status: Literal["success", "partial"] = (
            "success" if final_review.approved else "partial"
        )
        if not final_review.approved:
            warnings.append(
                f"Final review did not approve the draft: {final_review.reason}"
            )

        return ExplorationReport(
            status=status,
            final_draft=draft,
            steps=steps,
            artifacts=self.kernel.list_artifacts(),
            warnings=[*warnings, *draft.warnings],
        )
