"""新数据链路共用限额；历史协议的固定限制不随新配置变化。"""

import json
from pathlib import Path

from .protocol_v2 import fields

DEFAULT_DATA_LIMITS = json.loads(
    Path(__file__).with_name("data_limits.json").read_text()
)
LIMIT_KEYS = tuple(DEFAULT_DATA_LIMITS)


def validate_limits(value):
    fields(value, LIMIT_KEYS)
    if any(type(v) is not int or not 1 <= v <= 2**53 - 1 for v in value.values()):
        raise ValueError("Invalid data limits")
    return value
