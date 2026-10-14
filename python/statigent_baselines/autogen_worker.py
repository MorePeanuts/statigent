"""官方 AutoGen 0.2 双代理；仅模型/执行/历史字段与交付边界适配。"""

import json
from types import SimpleNamespace

from autogen import AssistantAgent, UserProxyAgent
from autogen.coding.base import CodeResult
from autogen.coding.markdown_code_extractor import MarkdownCodeExtractor

from statigent_baselines.bridge import validate_payload

FINAL_MARKER = "STATIGENT_FINAL\n"


class HostModelClient:
    def __init__(self, config, bridge):
        self.bridge = bridge

    def create(self, params):
        messages = []
        for message in params["messages"]:
            # AutoGen 的显示名称不是模型角色；实际角色及供应商历史保留。
            messages.append(
                {
                    k: v
                    for k, v in message.items()
                    if k
                    in (
                        "role",
                        "content",
                        "reasoning_content",
                        "tool_calls",
                        "tool_call_id",
                    )
                }
            )
        result = self.bridge.request(
            "model.request", stage="assistant", messages=messages
        )
        message = result["message"]
        if result["finish_reason"] not in ("stop", "tool_calls"):
            raise RuntimeError("Incomplete model output cannot execute")
        return SimpleNamespace(
            model=result["model"],
            choices=[SimpleNamespace(message=message)],
            host_usage=result["usage"],
            cost=0,
        )

    def message_retrieval(self, response):
        return [choice.message for choice in response.choices]

    def cost(self, response):
        # AutoGen 的本地价格统计不进入评测账；真实用量只由宿主累计一次。
        return 0

    @staticmethod
    def get_usage(response):
        usage = response.host_usage
        return {
            "prompt_tokens": usage["input_tokens"],
            "completion_tokens": usage["output_tokens"],
            "total_tokens": usage["total_tokens"],
            "cost": 0,
            "model": response.model,
        }


class HostCodeExecutor:
    def __init__(self, bridge):
        self.bridge = bridge
        self.code_extractor = MarkdownCodeExtractor()

    def execute_code_blocks(self, code_blocks):
        outputs = []
        for block in code_blocks:
            if block.language not in ("python", "py", ""):
                return CodeResult(
                    exit_code=1,
                    output="Only Python blocks are enabled; no installation/network",
                )
            result = self.bridge.request("execution.execute", code=block.code)
            outputs.append(result["preview"])
            if result["status"] != "ok":
                return CodeResult(exit_code=1, output="\n".join(outputs))
        return CodeResult(exit_code=0, output="\n".join(outputs))

    def restart(self):
        raise RuntimeError("Automatic executor restart/replay disabled")


class HistoryAssistant(AssistantAgent):
    def _append_oai_message(self, message, role, conversation_id, is_sending):
        accepted = super()._append_oai_message(
            message, role, conversation_id, is_sending
        )
        if (
            accepted
            and role == "assistant"
            and isinstance(message, dict)
            and "reasoning_content" in message
        ):
            # 官方 0.2 的白名单丢弃此供应商字段；只补存原值，不改变对话决策。
            self._oai_messages[conversation_id][-1]["reasoning_content"] = message[
                "reasoning_content"
            ]
        return accepted


def final_submission(message):
    content = message.get("content")
    if not isinstance(content, str) or not content.startswith(FINAL_MARKER):
        return None
    try:
        value = json.loads(content[len(FINAL_MARKER) :])
        validate_payload("submission.finish", {"submission": value})
        return value
    except (ValueError, TypeError):
        return None


def run(view, bridge):
    turns = view["options"]["max_turns"]
    instructions = (
        "Use Python code blocks only. All code executes in an isolated CPU container. "
        "Inputs are under /input; write reports and images under /workspace. "
        "Do not install dependencies or access the network. Each code block starts "
        "a new Python process; files persist. No LLM/tool is available after final "
        "submission. When finished, send exactly STATIGENT_FINAL followed by a "
        "newline and one JSON object: "
        '{"kind":"text","answer":"..."}, {"kind":"report","path":"report.md"}, or '
        '{"kind":"predictions","bundle":"selected","entrypoint":"predict.py"}. '
        "For predictions save the fitted bundle under /tmp/baseline-models/<bundle>; "
        "never put training data in it. Test features are unavailable until frozen. "
        "The predict.py entry receives --features, --output and --schema paths "
        "and must only load/predict."
    )
    assistant = HistoryAssistant(
        "code_assistant",
        system_message=AssistantAgent.DEFAULT_SYSTEM_MESSAGE + "\n" + instructions,
        llm_config={
            "config_list": [
                {"model_client_cls": "HostModelClient", "model": "host-selected"}
            ],
            "cache_seed": None,
        },
        max_consecutive_auto_reply=turns,
        human_input_mode="NEVER",
    )
    assistant.register_model_client(HostModelClient, bridge=bridge)
    executor = UserProxyAgent(
        "execution_proxy",
        llm_config=False,
        human_input_mode="NEVER",
        max_consecutive_auto_reply=turns,
        is_termination_msg=lambda message: final_submission(message) is not None,
        code_execution_config={
            "executor": HostCodeExecutor(bridge),
            "last_n_messages": 1,
        },
    )
    executor.initiate_chat(
        assistant,
        message=json.dumps(
            {
                "goal": view["goal"],
                "constraints": view["constraints"],
                "files": view["files"],
                "output": view["output"],
                "seed": view["seed"],
            },
            ensure_ascii=False,
        ),
        max_turns=turns,
        cache=None,
        summary_method=None,
        silent=True,
    )
    submission = final_submission(assistant.last_message(executor))
    if submission is None:
        raise RuntimeError("AutoGen ended without an explicit final submission")
    bridge.request("submission.finish", submission=submission)
