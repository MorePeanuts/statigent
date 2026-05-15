from pathlib import Path
from unittest.mock import MagicMock, patch

from langchain.messages import AIMessage, HumanMessage, ToolMessage

from statigent.baseline.react import (
    _SYSTEM_PROMPT,
    ReactBaselineAgent,
    _serialize_messages,
    make_bash_tool,
    make_list_dir_tool,
    make_python_tool,
    make_read_file_tool,
    make_write_file_tool,
)
from statigent.sandbox.docker import DockerSandbox


class TestBashTool:
    @patch.object(DockerSandbox, "exec")
    def test_runs_bash_command(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "hello\n"
        sandbox = DockerSandbox()
        tool = make_bash_tool(sandbox)
        result = tool.invoke({"command": "echo hello"})
        mock_exec.assert_called_once_with("echo hello")
        assert result == "hello\n"


class TestPythonTool:
    @patch.object(DockerSandbox, "exec")
    def test_executes_python_code(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "5\n"
        sandbox = DockerSandbox()
        tool = make_python_tool(sandbox)
        result = tool.invoke({"code": "print(2 + 3)"})
        assert "5" in result

    @patch.object(DockerSandbox, "exec")
    def test_writes_code_to_temp_file(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = ""
        sandbox = DockerSandbox()
        tool = make_python_tool(sandbox)
        tool.invoke({"code": "import pandas as pd"})
        cmd = mock_exec.call_args[0][0]
        assert "/tmp/_statigent_exec.py" in cmd
        assert "python /tmp/_statigent_exec.py" in cmd

    @patch.object(DockerSandbox, "exec")
    def test_truncates_long_output(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "x\n" * 50_000
        sandbox = DockerSandbox()
        tool = make_python_tool(sandbox)
        result = tool.invoke({"code": "print('long')"})
        assert len(result) < 100_000


class TestReadFileTool:
    @patch.object(DockerSandbox, "exec")
    def test_reads_file(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "name,age\nAlice,30\n"
        sandbox = DockerSandbox()
        tool = make_read_file_tool(sandbox)
        result = tool.invoke({"file_path": "/workspace/data.csv"})
        assert "Alice" in result

    @patch.object(DockerSandbox, "exec")
    def test_reads_file_with_max_lines(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "line1\nline2\n"
        sandbox = DockerSandbox()
        tool = make_read_file_tool(sandbox)
        tool.invoke({"file_path": "/workspace/data.csv", "max_lines": 2})
        cmd = mock_exec.call_args[0][0]
        assert "head -n 2" in cmd

    @patch.object(DockerSandbox, "exec")
    def test_reads_file_no_max_lines(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "all content\n"
        sandbox = DockerSandbox()
        tool = make_read_file_tool(sandbox)
        tool.invoke({"file_path": "/workspace/data.csv", "max_lines": 0})
        cmd = mock_exec.call_args[0][0]
        assert "cat " in cmd


class TestWriteFileTool:
    @patch.object(DockerSandbox, "exec")
    def test_writes_file(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = ""
        sandbox = DockerSandbox()
        tool = make_write_file_tool(sandbox)
        tool.invoke({"file_path": "/workspace/output.txt", "content": "hello"})
        cmd = mock_exec.call_args[0][0]
        assert "cat >" in cmd
        assert "/workspace/output.txt" in cmd
        assert "hello" in cmd

    @patch.object(DockerSandbox, "exec")
    def test_returns_success_message(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = ""
        sandbox = DockerSandbox()
        tool = make_write_file_tool(sandbox)
        result = tool.invoke({"file_path": "/workspace/out.txt", "content": "x"})
        assert "Successfully" in result


class TestListDirTool:
    @patch.object(DockerSandbox, "exec")
    def test_lists_directory(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = (
            "total 8\ndrwxr-xr-x 2 root root 4096 .\n"
            "-rw-r--r-- 1 root root 100 data.csv\n"
        )
        sandbox = DockerSandbox()
        tool = make_list_dir_tool(sandbox)
        result = tool.invoke({"path": "/workspace"})
        assert "data.csv" in result

    @patch.object(DockerSandbox, "exec")
    def test_default_path_is_workspace(self, mock_exec: MagicMock) -> None:
        mock_exec.return_value = "total 0\n"
        sandbox = DockerSandbox()
        tool = make_list_dir_tool(sandbox)
        tool.invoke({})
        cmd = mock_exec.call_args[0][0]
        assert "/workspace" in cmd


class TestReactBaselineAgentInit:
    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_default_model_name(
        self,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_create_agent.return_value = MagicMock()
        agent = ReactBaselineAgent()
        assert agent.model_name == "deepseek-v4-flash"
        mock_get_model.assert_called_once_with("deepseek-v4-flash")

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_custom_model_name(
        self,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_create_agent.return_value = MagicMock()
        agent = ReactBaselineAgent(model_name="gpt-4o")
        assert agent.model_name == "gpt-4o"
        mock_get_model.assert_called_once_with("gpt-4o")

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_agent_created_with_tools_and_prompt(
        self, mock_create_agent: MagicMock, mock_get_model: MagicMock
    ) -> None:
        mock_llm = MagicMock()
        mock_get_model.return_value = mock_llm
        mock_create_agent.return_value = MagicMock()
        ReactBaselineAgent()
        mock_create_agent.assert_called_once()
        call_kwargs = mock_create_agent.call_args
        assert call_kwargs[0][0] is mock_llm
        assert len(call_kwargs[0][1]) == 2
        assert call_kwargs[1]["system_prompt"] == _SYSTEM_PROMPT


class TestRunAnalysisForEval:
    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_returns_response_and_trace(
        self, mock_create_agent: MagicMock, mock_get_model: MagicMock
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [
                HumanMessage(content="What is the mean age?"),
                AIMessage(content="The mean age is 30"),
            ]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        response, trace = agent.run_analysis_for_eval("What is the mean age?")
        assert response == "The mean age is 30"
        assert len(trace) == 2
        assert trace[0]["role"] == "user"
        assert trace[1]["role"] == "assistant"

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_includes_files_in_message(
        self, mock_create_agent: MagicMock, mock_get_model: MagicMock
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        agent.run_analysis_for_eval(
            "Analyze",
            files=[Path("/data/train.csv"), Path("/data/test.csv")],
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "/data/train.csv" in msg["content"]
        assert "/data/test.csv" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_includes_task_instructions(
        self, mock_create_agent: MagicMock, mock_get_model: MagicMock
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        agent.run_analysis_for_eval(
            "Analyze",
            task_instructions="Answer in JSON format",
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "Answer in JSON format" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_no_files_no_task_instructions(
        self, mock_create_agent: MagicMock, mock_get_model: MagicMock
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        agent = ReactBaselineAgent()
        agent.run_analysis_for_eval("What is 2+2?")
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "What is 2+2?" in msg["content"]
        assert "Available data files" not in msg["content"]


class TestRunModelingForEval:
    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_returns_output_path_and_trace(
        self,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [
                HumanMessage(content="Build a model"),
                AIMessage(content="Done"),
            ]
        }
        mock_create_agent.return_value = mock_agent

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        result_path, trace = agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
        )
        assert result_path == tmp_path / "submission.csv"
        assert len(trace) == 2

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_includes_paths_in_message(
        self,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert str(train) in msg["content"]
        assert str(test) in msg["content"]
        assert str(sample) in msg["content"]
        assert "submission.csv" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_includes_task_instructions(
        self,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
            task_instructions="Use random forest",
        )
        msg = mock_agent.invoke.call_args[0][0]["messages"][0]
        assert "Use random forest" in msg["content"]

    @patch("statigent.baseline.react.get_model")
    @patch("statigent.baseline.react.create_agent")
    def test_warns_when_submission_not_created(
        self,
        mock_create_agent: MagicMock,
        mock_get_model: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_get_model.return_value = MagicMock()
        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [HumanMessage(content="q"), AIMessage(content="answer")]
        }
        mock_create_agent.return_value = mock_agent

        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("x,y\n3,0\n")

        agent = ReactBaselineAgent()
        with patch("statigent.baseline.react.logger") as mock_logger:
            result_path, _trace = agent.run_modeling_for_eval(
                "Build a model",
                train_path=train,
                test_path=test,
                sample_submission_path=sample,
            )
            mock_logger.warning.assert_called_once()
        assert not result_path.exists()


class TestSerializeMessages:
    def test_serializes_human_message(self) -> None:
        msgs = [HumanMessage(content="What is the mean?")]
        trace = _serialize_messages(msgs)
        assert trace[0] == {"role": "user", "content": "What is the mean?"}

    def test_serializes_ai_message_with_tool_calls(self) -> None:
        msgs = [
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "python_repl", "args": {"code": "print(1)"}, "id": "tc1"}
                ],
            )
        ]
        trace = _serialize_messages(msgs)
        assert trace[0]["role"] == "assistant"
        assert trace[0]["content"] == ""
        assert len(trace[0]["tool_calls"]) == 1
        assert trace[0]["tool_calls"][0]["name"] == "python_repl"

    def test_serializes_tool_message(self) -> None:
        msgs = [ToolMessage(content="42", name="python_repl", tool_call_id="tc1")]
        trace = _serialize_messages(msgs)
        assert trace[0] == {
            "role": "tool",
            "name": "python_repl",
            "content": "42",
            "tool_call_id": "tc1",
        }

    def test_serializes_full_conversation(self) -> None:
        msgs = [
            HumanMessage(content="Analyze this"),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "read_file",
                        "args": {"file_path": "/data.csv"},
                        "id": "tc1",
                    }
                ],
            ),
            ToolMessage(content="a,b\n1,2", name="read_file", tool_call_id="tc1"),
            AIMessage(content="The answer is 3"),
        ]
        trace = _serialize_messages(msgs)
        assert len(trace) == 4
        assert trace[0]["role"] == "user"
        assert trace[1]["role"] == "assistant"
        assert trace[2]["role"] == "tool"
        assert trace[3]["role"] == "assistant"
        assert trace[3]["content"] == "The answer is 3"


class TestProtocolConformance:
    def test_satisfies_data_science_agent_protocol(self) -> None:
        agent = ReactBaselineAgent.__new__(ReactBaselineAgent)
        agent.name = "react-baseline"
        agent.model_name = "test"
        assert agent.name == "react-baseline"
        assert hasattr(agent, "run_analysis_for_eval")
        assert hasattr(agent, "run_modeling_for_eval")
