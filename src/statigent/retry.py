"""Shared retry utilities for transient API errors."""

from loguru import logger
from openai import APIConnectionError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

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
