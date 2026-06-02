from statigent.exploration.prompts import (
    CODER_SYSTEM_PROMPT,
    DEBUGGER_SYSTEM_PROMPT,
    FINAL_REVIEWER_SYSTEM_PROMPT,
    INSPECTOR_PLAN_SYSTEM_PROMPT,
    REVIEWER_PLAN_SYSTEM_PROMPT,
)


def _normalized(text: str) -> str:
    return " ".join(text.casefold().split())


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
    text = _normalized(INSPECTOR_PLAN_SYSTEM_PROMPT)

    assert "stop is not a final answer" in text
    assert "information is sufficient" in text
    assert "reviewer" in text
    assert "leave coder_instruction empty" in text


def test_inspector_prompt_sets_role_duty_and_small_coder_steps() -> None:
    text = _normalized(INSPECTOR_PLAN_SYSTEM_PROMPT)

    assert "you are the inspector" in text
    assert "determine the next data exploration direction" in text
    assert "tell the coder what data support is needed" in text
    assert "small" in text
    assert "do not ask the coder to write a large analysis script" in text


def test_inspector_prompt_treats_stop_as_no_instruction_branch() -> None:
    text = _normalized(INSPECTOR_PLAN_SYSTEM_PROMPT)

    assert "if the current information is enough" in text
    assert "stop: yes" in text
    assert "do not issue coder instructions" in text
    assert "stop: no" in text
    assert "coder_instruction" in text


def test_reviewer_prompt_sets_role_duty_and_behavior_guidelines() -> None:
    text = _normalized(REVIEWER_PLAN_SYSTEM_PROMPT)

    assert "you are the reviewer" in text
    assert "audit the inspector's proposed next exploration direction" in text
    assert "task objective" in text
    assert "dataset profile" in text
    assert "full execution path" in text
    assert "behavior guidelines" in text
    assert "irrelevant" in text
    assert "redundant" in text
    assert "unsafe" in text
    assert "too broad" in text
    assert "unsupported" in text
    assert "unnecessary" in text


def test_reviewer_prompt_audits_stop_requests_against_evidence() -> None:
    text = _normalized(REVIEWER_PLAN_SYSTEM_PROMPT)

    assert "stop" in text
    assert "do not approve final drafting" in text
    assert "executed evidence" in text
    assert "feedback" in text


def test_reviewer_prompt_keeps_review_scope_on_evidence_not_final_prose() -> None:
    text = _normalized(REVIEWER_PLAN_SYSTEM_PROMPT)

    assert "do not use external dataset expectations" in text
    assert "do not require the coder to generate final prose" in text
    assert "final formatting" in text
    assert "inspector's final draft" in text


def test_reviewer_prompt_keeps_structured_output_instruction_concise() -> None:
    text = _normalized(REVIEWER_PLAN_SYSTEM_PROMPT)

    assert "return a reviewerplandecision structured output" in text
    assert "- approved:" not in text
    assert "- approved_final:" not in text
    assert "- coder_instruction:" not in text
    assert "- feedback:" not in text


def test_coder_prompt_covers_execution_result_observation_reply() -> None:
    text = _normalized(CODER_SYSTEM_PROMPT)

    assert "you are the coder" in text
    assert "approved inspector exploration instructions" in text
    assert "append_code_cell" in text
    assert "execution result" in text
    assert "reply to the inspector" in text
    assert "observation" in text
    assert "small" in text
    assert "focused" in text
    assert "behavior guidelines" in text
    assert "large analysis script" in text
    assert "final answer prose" in text
    assert "semantic issue" in text
    assert "boundary condition" in text
    assert "do not execute" not in text


def test_debugger_prompt_sets_role_duty_and_behavior_guidelines() -> None:
    text = _normalized(DEBUGGER_SYSTEM_PROMPT)

    assert "you are the debugger" in text
    assert "repair failed exploration cells" in text
    assert "replace_code_cell" in text
    assert "record_debug_lesson" in text
    assert "behavior guidelines" in text
    assert "minimal" in text
    assert "preserve" in text
    assert "do not rewrite the whole analysis" in text
    assert "already bound" not in text
    assert "failed cell id" not in text


def test_final_reviewer_prompt_sets_role_duty_and_behavior_guidelines() -> None:
    text = _normalized(FINAL_REVIEWER_SYSTEM_PROMPT)

    assert "you are the final reviewer" in text
    assert "audit the inspector's final draft" in text
    assert "task objective" in text
    assert "full execution path" in text
    assert "output constraints" in text
    assert "evidence" in text
    assert "behavior guidelines" in text
    assert "unsupported" in text
    assert "uncertainty" in text


def test_final_reviewer_prompt_keeps_structured_output_instruction_concise() -> None:
    text = _normalized(FINAL_REVIEWER_SYSTEM_PROMPT)

    assert "finalreviewdecision" in text
    assert "- approved:" not in text
    assert "- feedback:" not in text
    assert "reason" not in text
    assert "additional_exploration_focus" not in text


def test_inspector_prompt_uses_freeform_action_label() -> None:
    text = INSPECTOR_PLAN_SYSTEM_PROMPT.casefold()

    assert "short free-form action label" in text
