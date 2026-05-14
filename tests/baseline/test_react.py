from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from langchain.messages import AIMessage, HumanMessage, ToolMessage

from statigent.baseline.react import (
    _SYSTEM_PROMPT,
    ReactBaselineAgent,
    _serialize_messages,
    python_repl,
    read_file,
)


class TestPythonReplTool:
    def test_executes_simple_code(self) -> None:
        result = python_repl.invoke({"code": "print(2 + 3)"})
        assert "5" in result

    def test_returns_output_as_string(self) -> None:
        result = python_repl.invoke({"code": "print('hello')"})
        assert isinstance(result, str)
        assert "hello" in result


class TestReadFileTool:
    def test_reads_file_content(self, tmp_path: Path) -> None:
        f = tmp_path / "data.csv"
        f.write_text("name,age\nAlice,30\n")
        result = read_file.invoke({"file_path": str(f)})
        assert "Alice" in result

    def test_raises_on_missing_file(self) -> None:
        with pytest.raises(FileNotFoundError):
            read_file.invoke({"file_path": "/nonexistent/file.csv"})


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
