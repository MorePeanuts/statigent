"""固定 DatawiseAgent 的边界子类；规划、执行、修复、过滤仍调用官方实现。"""

import asyncio
import json
import logging
import os
import shutil
import sys
import uuid
from contextvars import ContextVar
from functools import wraps
from pathlib import Path

from statigent_baselines.bridge import validate_payload
from statigent_baselines.import_boundary import upstream_import_boundary
from statigent_baselines.registration import register_from_message

STAGE = ContextVar("datawise_stage", default="initialization")
REPLAY_REASONS = {"post_filter": "post-filter", "planning": "plan-rollback"}


def run(view, bridge):
    # 上游导入会建立日志目录；一次性副本不污染已校验源码，不接收请求给出的路径。
    source = Path(__file__).resolve().parents[2] / ".tools/baselines/datawiseagent"
    copied = Path.cwd() / "upstream"
    copied.mkdir()
    for directory in ("datawiseagent", "configs"):
        shutil.copytree(source / directory, copied / directory)
    sys.path.insert(0, str(copied))
    os.chdir(copied)
    with upstream_import_boundary():
        from datawiseagent.agents.datawise_agent import DatawiseAgent
        from datawiseagent.coding.base import IPythonCodeResult
        from datawiseagent.coding.jupyter import JupyterCodeExecutor
        from datawiseagent.common.types import LLMResult, MarkdownCell
        from datawiseagent.common.types.cell import CodeCell
        from datawiseagent.llms.base import BaseChatModel
        from datawiseagent.llms.openai import OpenAIChat
        from datawiseagent.memory.chat_history import CellHistoryMemory
        from datawiseagent.memory.session import Session
        from datawiseagent.prompts.datawise import FULFILL_INSTRUCTION
        from pydantic import PrivateAttr

    # 日志只走父进程有界 stderr，不用上游打字延迟或额外的无限文件日志。
    for name in ("LOGGER", "TYPER"):
        logger = logging.getLogger(name)
        for handler in logger.handlers[:]:
            logger.removeHandler(handler)
            handler.close()
        logger.addHandler(logging.StreamHandler(sys.stderr))

    class HostModel(BaseChatModel):
        max_retry: int = 0
        _last: dict = PrivateAttr(default_factory=dict)

        def get_spend(self):
            # 上游内部不结算美元；父账是唯一权威。
            raise RuntimeError("Use the host usage ledger")

        async def agenerate_response(
            self, prepend_prompt="", history=None, append_prompt="", **kwargs
        ):
            if kwargs:
                raise ValueError("Unsupported upstream model arguments")
            before = (
                [prepend_prompt] if isinstance(prepend_prompt, str) else prepend_prompt
            )
            after = [append_prompt] if isinstance(append_prompt, str) else append_prompt
            messages = OpenAIChat.construct_messages(self, before, history or [], after)
            messages = [{k: v for k, v in m.items() if k != "name"} for m in messages]
            result = bridge.request(
                "model.request", stage=STAGE.get(), messages=messages
            )
            message = result["message"]
            if result["finish_reason"] != "stop" or message.get("tool_calls"):
                raise RuntimeError("Datawise requires a complete notebook response")
            if not isinstance(message.get("content"), str):
                raise ValueError("Notebook response must be text")
            self._last = message
            register_from_message(message["content"], bridge, notebook=True)
            usage = result["usage"]
            return LLMResult(
                role="assistant",
                content=message["content"],
                name="Datawise_Agent",
                send_tokens=usage["input_tokens"],
                recv_tokens=usage["output_tokens"],
                total_tokens=usage["total_tokens"],
            )

    class HostHistory(CellHistoryMemory):
        _reasoning: dict = PrivateAttr(default_factory=dict)

        def organize_cells_to_messages(self, organized_cells, format):
            messages = super().organize_cells_to_messages(organized_cells, format)
            # 上游按相邻单元合并 assistant 内容；同样分组保留原供应商推理字段。
            groups, reasons, in_group = [], [], False
            for cell in organized_cells:
                is_assistant = isinstance(cell, CodeCell) or (
                    isinstance(cell, MarkdownCell) and cell.role == "assistant"
                )
                if is_assistant:
                    in_group = True
                    reason = self._reasoning.get(cell.id)
                    if reason is not None and reason not in reasons:
                        reasons.append(reason)
                elif in_group:
                    groups.append(reasons)
                    reasons, in_group = [], False
            if in_group:
                groups.append(reasons)
            assistant_messages = [m for m in messages if m["role"] == "assistant"]
            if len(groups) != len(assistant_messages):
                raise RuntimeError("Upstream history grouping changed")
            for message, parts in zip(assistant_messages, groups, strict=True):
                if parts:
                    message["reasoning_content"] = "\n".join(parts)
            return messages

    class HostExecutor(JupyterCodeExecutor):
        def __init__(self):
            # 不调用默认构造器，不启动宿主 Jupyter、不创建 Docker 客户端。
            self.known = True

        async def check_jupyter_kernel_health(self):
            if not self.known:
                raise RuntimeError("Unknown execution state; recovery forbidden")

        async def execute_code_blocks(self, code_blocks, custom_timeout=None):
            if custom_timeout is not None:
                raise RuntimeError("Timed-out execution cannot be replayed")
            await self.check_jupyter_kernel_health()
            blocks = code_blocks if isinstance(code_blocks, list) else [code_blocks]
            outputs, files, elapsed = [], [], 0
            for block in blocks:
                if block.language not in ("python", "py", ""):
                    return IPythonCodeResult(exit_code=1, output="Only Python enabled")
                self.known = False
                result = bridge.request("execution.execute", code=block.code)
                if result["status"] not in ("ok", "error"):
                    raise RuntimeError("Execution did not finish in a known state")
                self.known = True
                outputs.append(result["preview"])
                files.extend(a["path"] for a in result.get("artifacts", []))
                elapsed += result.get("elapsed_ms", 0) / 1000
                if result["status"] == "error":
                    return IPythonCodeResult(
                        exit_code=1,
                        output="\n".join(outputs),
                        output_files=files,
                        time_consumed=elapsed,
                    )
            return IPythonCodeResult(
                exit_code=0,
                output="\n".join(outputs),
                output_files=files,
                time_consumed=elapsed,
            )

        async def restart(self):
            reason = REPLAY_REASONS.get(STAGE.get())
            if reason is None or not self.known:
                raise RuntimeError("Automatic recovery forbidden")
            bridge.request("execution.restart", reason=reason)

    class HostWorkspace:
        root_dir = Path("/workspace")

        def initialize(self, maintained_dirs):
            # 新执行容器只重新发布原输入，派生文件已被销毁，不在宿主清理路径。
            if maintained_dirs != [Path("/input"), Path("/workspace/system")]:
                raise ValueError("Unexpected maintained directories")

        def fetch_workspace_status(self):
            return json.dumps(bridge.request("workspace.status"), ensure_ascii=False)

    class HostSession(Session):
        def __init__(self):
            self.session_id = uuid.uuid4()
            self.session_name = "baseline"
            self.chat_history = HostHistory()
            self.code_executor = HostExecutor()
            self.workspace = HostWorkspace()
            self.input_dir = Path("/input")
            self.system_dir = Path("/workspace/system")
            self.current_user_query = None

        def workspace_root_dir(self):
            return "/workspace (inputs: /input)"

        async def safe_execute_code_blocks(self, code_blocks):
            # 不进入官方根据字符串触发的自动故障恢复路径。
            return await self.code_executor.execute_code_blocks(code_blocks)

        async def rerun_cells(self):
            if STAGE.get() not in REPLAY_REASONS:
                raise RuntimeError("Replay outside explicit FST transition")
            await super().rerun_cells()

    class HostAgent(DatawiseAgent):
        def __init__(self):
            self.llm = HostModel()
            self.sessions = {}
            self.agent_manager = None

        async def _update_messages(self, session, node, *args, **kwargs):
            cells = node.cells_generated
            if not isinstance(cells, list):
                cells = [cells]
            reason = self.llm._last.get("reasoning_content")
            if reason is not None:
                for cell in cells:
                    if (
                        isinstance(cell, (MarkdownCell, CodeCell))
                        and cell.role == "assistant"
                    ):
                        session.chat_history._reasoning[cell.id] = reason
            return await super()._update_messages(session, node, *args, **kwargs)

        async def save_session_content(self, session):
            # 通过有界桥接保存原始 Notebook/节点，不让模型选择宿主日志路径。
            bridge.request(
                "notebook.record",
                notebook=json.loads(session.chat_history.model_dump_json()),
            )

    def stage_boundary(method, stage):
        @wraps(method)
        async def wrapped(self, *args, **kwargs):
            token = STAGE.set(stage)
            try:
                return await method(self, *args, **kwargs)
            finally:
                STAGE.reset(token)

        return wrapped

    for name, stage in {
        "_initiate_step": "initiate",
        "_append_code": "execution",
        "_update_plan": "planning",
        "_self_debug_execution": "debug",
        "_self_debug_filter": "post_filter",
    }.items():
        setattr(HostAgent, name, stage_boundary(getattr(DatawiseAgent, name), stage))

    agent, session = HostAgent(), HostSession()
    agent.sessions[session.session_id] = session
    options = view["options"]
    config = {
        "plan": {"planning": True, "planning_max_number": options["max_plan_depth"]},
        "execution": {"execution_max_number": options["max_execution_depth"]},
        "debug": {"self_debug": True, "debug_max_number": options["max_debug_depth"]},
        "max_step_number": options["max_steps"],
        "evaluation": False,
    }
    bootstrap = (
        "# Environment\nPython 3.12, preinstalled CPU packages, "
        "no network or installation. "
        "Read task files only at /input; save outputs at /workspace. "
        "These paths replace the upstream ./input, ./display and ./working layout. "
        "Use Python blocks; preserve the original FST action tags. On the final "
        "Fulfill USER INSTRUCTION response include one markdown cell containing "
        "STATIGENT_FINAL followed by a newline and one JSON object: "
        '{"kind":"text","answer":"..."}, '
        '{"kind":"report","path":"report.md"}, or '
        '{"kind":"predictions","bundle":"selected","entrypoint":"predict.py"}. '
        "Save fitted bundles under /tmp/baseline-models/<bundle>. "
        "Test features are withheld until frozen; predict.py accepts "
        "--features, --output, --schema and only loads/predicts."
        " After fitting, optionally emit a markdown cell beginning with "
        'STATIGENT_BUNDLE followed by a newline and {"bundle":"selected",'
        '"entrypoint":"predict.py"} to allow no-LLM delivery on budget exhaustion.'
    )
    session.chat_history.initialize(
        [MarkdownCell(content=bootstrap, role="system", name="System")]
    )
    query = json.dumps(
        {k: view[k] for k in ("goal", "constraints", "files", "output", "seed")},
        ensure_ascii=False,
    )
    asyncio.run(agent.chat(session.session_id, query, agent_config=config))
    content = agent.llm._last.get("content", "")
    if FULFILL_INSTRUCTION not in content:
        raise RuntimeError("Datawise ended without an explicit completion")
    marker = "STATIGENT_FINAL\n"
    if content.count(marker) != 1:
        raise RuntimeError("Missing explicit Datawise submission")
    submission, _ = json.JSONDecoder().raw_decode(content.split(marker, 1)[1])
    validate_payload("submission.finish", {"submission": submission})
    bridge.request("submission.finish", submission=submission)
