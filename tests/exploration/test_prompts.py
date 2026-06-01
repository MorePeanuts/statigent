from statigent.exploration.prompts import (
    CODER_SYSTEM_PROMPT,
    DEBUGGER_SYSTEM_PROMPT,
    FINAL_REVIEWER_SYSTEM_PROMPT,
    INSPECTOR_PLAN_SYSTEM_PROMPT,
    REVIEWER_PLAN_SYSTEM_PROMPT,
)


def test_inspector_prompt_requires_action_block() -> None:
    text = INSPECTOR_PLAN_SYSTEM_PROMPT.casefold()

    assert "action:" in text
    assert "question:" in text
    assert "evidence_needed:" in text
    assert "coder_instruction:" in text
    assert "stop:" in text
    assert "end every planning response" in text
    assert "explorationactionkind" not in text
    assert "custom_analysis" not in text


def test_inspector_prompt_defines_stop_as_final_review_request() -> None:
    text = INSPECTOR_PLAN_SYSTEM_PROMPT.casefold()

    assert "stop is not a final answer" in text
    assert "request reviewer approval" in text
    assert "executed evidence" in text
    assert "leave coder_instruction empty" in text
    assert "do not use stop" in text


def test_reviewer_prompt_requires_structured_decision_and_rejection_criteria() -> None:
    text = REVIEWER_PLAN_SYSTEM_PROMPT.casefold()

    assert "reviewerplandecision" in text
    assert "approved" in text
    assert "approved_final" in text
    assert "coder_instruction" in text
    assert "copy" in text
    assert "feedback" in text
    assert "full execution path" in text
    assert "irrelevant" in text
    assert "redundant" in text
    assert "unsafe" in text
    assert "too broad" in text
    assert "unsupported" in text
    assert "unnecessary" in text
    assert "final" in text


def test_reviewer_prompt_audits_stop_requests_against_evidence() -> None:
    text = REVIEWER_PLAN_SYSTEM_PROMPT.casefold()

    assert "stop" in text
    assert "reject stop" in text
    assert "executed evidence" in text
    assert "approved_final" in text


def test_coder_prompt_requires_single_append_without_execution() -> None:
    text = CODER_SYSTEM_PROMPT.casefold()

    assert "append_code_cell" in text
    assert "exactly one" in text
    assert "incremental notebook cell" in text
    assert "do not execute" in text


def test_debugger_prompt_uses_prebound_replace_tool_and_records_lessons() -> None:
    text = DEBUGGER_SYSTEM_PROMPT.casefold()

    assert "replace_code_cell" in text
    assert "already bound" in text
    assert "failed cell id" in text
    assert "record_debug_lesson" in text


def test_final_reviewer_prompt_requires_evidence_and_output_constraints() -> None:
    text = FINAL_REVIEWER_SYSTEM_PROMPT.casefold()

    assert "evidence" in text
    assert "output constraints" in text
    assert "finalreviewdecision" in text
    assert "approved" in text
    assert "feedback" in text
    assert "reason" not in text
    assert "additional_exploration_focus" not in text


def test_inspector_prompt_uses_freeform_action_label() -> None:
    text = INSPECTOR_PLAN_SYSTEM_PROMPT.casefold()

    assert "short free-form action label" in text
