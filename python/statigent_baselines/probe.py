"""零模型导入探针；不实例化上游默认模型、Jupyter 或 Docker 执行器。"""

import argparse
import inspect
import json
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from importlib.metadata import version
from pathlib import Path

from import_boundary import upstream_import_boundary


def probe_autogen():
    from autogen import AssistantAgent, UserProxyAgent
    from autogen.coding.base import CodeExecutor
    from autogen.oai.client import ModelClient

    assert version("pyautogen") == "0.2.35"
    for name in ("create", "message_retrieval", "cost", "get_usage"):
        assert callable(getattr(ModelClient, name))
    assert callable(CodeExecutor.execute_code_blocks)
    assistant = AssistantAgent("probe_assistant", llm_config=False)
    executor = UserProxyAgent(
        "probe_executor",
        llm_config=False,
        human_input_mode="NEVER",
        code_execution_config=False,
    )
    assert assistant.client is None and executor.client is None
    assert executor.human_input_mode == "NEVER"
    return {"method": "autogen", "version": version("pyautogen"), "model_calls": 0}


def probe_datawise(source: Path):
    # 上游 logger 在源码旁写文件；探针使用一次性副本，保持固定源码只读。
    with tempfile.TemporaryDirectory(prefix="statigent-datawise-probe-") as temp:
        root = Path(temp)
        shutil.copytree(source / "datawiseagent", root / "datawiseagent")
        shutil.copytree(source / "configs", root / "configs")
        previous = Path.cwd()
        sys.path.insert(0, str(root))
        try:
            os.chdir(root)
            with upstream_import_boundary():
                from datawiseagent.agents.datawise_agent import DatawiseAgent
                from datawiseagent.coding.jupyter import JupyterCodeExecutor
                from datawiseagent.llms.base import BaseChatModel

            stages = [
                "create_new_session",
                "_initiate_step",
                "_update_plan",
                "_append_code",
                "_execute_cells",
                "_self_debug_execution",
                "_self_debug_filter",
            ]
            for name in stages:
                assert inspect.iscoroutinefunction(getattr(DatawiseAgent, name))
            assert callable(BaseChatModel.agenerate_response)
            assert callable(JupyterCodeExecutor.execute_code_blocks)
            return {"method": "datawiseagent", "stages": stages, "model_calls": 0}
        finally:
            os.chdir(previous)
            sys.path.remove(str(root))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("method", choices=["autogen", "datawiseagent"])
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    if args.method == "datawiseagent" and args.source is None:
        parser.error("--source is required")
    with redirect_stdout(sys.stderr):
        result = (
            probe_autogen() if args.method == "autogen" else probe_datawise(args.source)
        )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
