"""Shared retry utilities for transient API errors."""

from typing import Any

from loguru import logger
from openai import APIConnectionError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from statigent.errors import StatigentParseError

_MAX_CONN_RETRIES = 3

retry_on_conn_error = retry(
    retry=retry_if_exception_type(APIConnectionError),
    stop=stop_after_attempt(_MAX_CONN_RETRIES),
    wait=wait_exponential(multiplier=2, min=4, max=60),
    reraise=True,
    before_sleep=lambda rs: logger.warning(
        "APIConnectionError on attempt {}/{}, retrying in {:.0f}s...",
        rs.attempt_number,
        _MAX_CONN_RETRIES,
        rs.next_action.sleep if rs.next_action else 0,
    ),
)


_MAX_PARSE_RETRIES = 3


def raise_on_parse_error(result: Any) -> Any:
    """Raise StatigentParseError if include_raw result has a parsing error."""
    if not isinstance(result, dict):
        raise StatigentParseError(
            f"Expected dict from include_raw=True, got {type(result).__name__}"
        )
    if result.get("parsing_error") is not None:
        raise StatigentParseError(str(result["parsing_error"]))
    parsed = result.get("parsed")
    if parsed is None:
        raise StatigentParseError("Structured output returned no parsed result")
    return parsed


def extract_usage_metadata(message: object) -> dict[str, int]:
    """Return normalized LangChain usage metadata from a model message."""
    usage = getattr(message, "usage_metadata", None)
    if not isinstance(usage, dict):
        return {}
    normalized: dict[str, int] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        value = usage.get(key)
        if isinstance(value, int):
            normalized[key] = value
    return normalized


retry_on_parse_error = retry(
    retry=retry_if_exception_type(StatigentParseError),
    stop=stop_after_attempt(_MAX_PARSE_RETRIES),
    wait=wait_exponential(multiplier=2, min=4, max=60),
    reraise=True,
    before_sleep=lambda rs: logger.warning(
        "Structured output parse error on attempt {}/{}, retrying in {:.0f}s...",
        rs.attempt_number,
        _MAX_PARSE_RETRIES,
        rs.next_action.sleep if rs.next_action else 0,
    ),
)


def invoke_structured_with_retries(runnable: Any, messages: list[Any]) -> Any:
    """Invoke a structured output runnable with conn retry + parse error detection."""
    raw = retry_on_conn_error(runnable.invoke)(messages)
    return raise_on_parse_error(raw)


def invoke_structured_with_usage(
    runnable: Any,
    messages: list[Any],
) -> tuple[Any, dict[str, int]]:
    """Invoke structured output and return parsed value with token usage."""
    raw = retry_on_conn_error(runnable.invoke)(messages)
    parsed = raise_on_parse_error(raw)
    raw_message = raw.get("raw") if isinstance(raw, dict) else None
    return parsed, extract_usage_metadata(raw_message)
