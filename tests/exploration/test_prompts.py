from statigent.exploration.prompts import (
    CODER_SYSTEM_PROMPT,
    DEBUGGER_SYSTEM_PROMPT,
    INSPECTOR_PLAN_SYSTEM_PROMPT,
)


def _normalized(text: str) -> str:
    return " ".join(text.casefold().split())


def test_inspector_prompt_requires_action_block() -> None:
    text = INSPECTOR_PLAN_SYSTEM_PROMPT.casefold()

    assert "action:" in text
    assert "question:" in text
    assert "evidence_needed:" in text
    assert "coder_instruction:" in text
    assert "done" in text
    assert "end every planning response" in text
    assert "explorationactionkind" not in text
    assert "custom_analysis" not in text


def test_inspector_prompt_defines_done_as_final_answer_marker() -> None:
    text = _normalized(INSPECTOR_PLAN_SYSTEM_PROMPT)

    assert "done" in text
    assert "final answer" in text
    assert "leave coder_instruction empty" in text
    assert "do not include done" in text
    assert "done is not a final answer" not in text
    assert "does not execute code" not in text
    assert "reviewer" not in text


def test_inspector_prompt_sets_role_duty_and_small_coder_steps() -> None:
    text = _normalized(INSPECTOR_PLAN_SYSTEM_PROMPT)

    assert "you are the inspector" in text
    assert "determine the next data exploration direction" in text
    assert "tell the coder what data support is needed" in text
    assert "small" in text
    assert "do not ask the coder to write a large analysis script" in text


def test_inspector_prompt_enforces_profile_and_task_restrictions() -> None:
    text = _normalized(INSPECTOR_PLAN_SYSTEM_PROMPT)

    assert "task brief restrictions" in text
    assert "dataset profile" in text
    assert "do not add unspecified preprocessing" in text
    assert "filtering" in text
    assert "encoding" in text
    assert "normalization" in text
    assert "profile" in text
    assert "missing_rates" in text
    assert "dtypes" in text


def test_inspector_prompt_treats_done_as_no_instruction_branch() -> None:
    text = _normalized(INSPECTOR_PLAN_SYSTEM_PROMPT)

    assert "if the current observations already contain the final answer" in text
    assert "append a final line containing only done" in text
    assert "do not issue coder instructions" in text
    assert "do not include done" in text
    assert "coder_instruction" in text


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


def test_inspector_prompt_uses_freeform_action_label() -> None:
    text = INSPECTOR_PLAN_SYSTEM_PROMPT.casefold()

    assert "short free-form action label" in text
