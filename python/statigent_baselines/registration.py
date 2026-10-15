"""显式已拟合模型登记；不从代码、目录或日志猜测模型选择。"""

import json
import re

from statigent_baselines.bridge import validate_payload


def register_from_message(content, bridge, notebook=False):
    if not isinstance(content, str):
        return
    if notebook:
        matches = re.findall(
            r"(?:^|\n)```markdown\nSTATIGENT_BUNDLE\n(.*?)\n```", content, re.DOTALL
        )
    else:
        matches = (
            [content[len("STATIGENT_BUNDLE\n") :]]
            if content.startswith("STATIGENT_BUNDLE\n")
            else []
        )
    if not matches:
        return
    if len(matches) != 1:
        raise ValueError("Ambiguous bundle registration")
    payload, _ = json.JSONDecoder().raw_decode(matches[0])
    validate_payload("bundle.register", payload)
    bridge.request("bundle.register", **payload)
