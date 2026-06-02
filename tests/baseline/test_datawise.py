from pathlib import Path
from unittest.mock import MagicMock, patch

from langchain.messages import AIMessage

from statigent.baseline.datawise import (
    DatawiseBaselineAgent,
    _extract_python_code_blocks,
)
from statigent.sandbox.docker import DockerSandbox


class TestExtractPythonCodeBlocks:
    def test_extracts_python_fenced_blocks(self) -> None:
        content = "Plan\n```python\nprint(1)\n```\n```py\nprint(2)\n```"

        blocks = _extract_python_code_blocks(content)

        assert blocks == ["print(1)", "print(2)"]

    def test_ignores_non_python_blocks(self) -> None:
        content = "```bash\necho nope\n```\n```text\nhello\n```"

        blocks = _extract_python_code_blocks(content)

        assert blocks == []


class TestDatawiseBaselineAgentInit:
    def test_default_params(self) -> None:
        agent = DatawiseBaselineAgent()

        assert agent.name == "datawise"
        assert agent.model_name == "deepseek-v4-flash"
        assert agent.sandbox_image == "statigent/ds-sandbox"
        assert agent.sandbox_network is False
        assert agent.sandbox_timeout == 600
        assert agent.max_iterations == 6

    def test_custom_params(self) -> None:
        agent = DatawiseBaselineAgent(
            model_name="gpt-4o",
            sandbox_image="custom/image",
            sandbox_network=True,
            sandbox_timeout=300,
            max_iterations=3,
        )

        assert agent.model_name == "gpt-4o"
        assert agent.sandbox_image == "custom/image"
        assert agent.sandbox_network is True
        assert agent.sandbox_timeout == 300
        assert agent.max_iterations == 3


class TestRunAnalysisForEval:
    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.datawise.get_model")
    def test_runs_python_cells_and_returns_final_response(
        self,
        mock_get_model: MagicMock,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_exec: MagicMock,
    ) -> None:
        mock_exec.side_effect = ["", "42\n"]
        model = MagicMock()
        model.invoke.side_effect = [
            AIMessage(content="<await>\n```python\nprint(6 * 7)\n```"),
            AIMessage(content="<end_step>\nThe answer is 42."),
        ]
        mock_get_model.return_value = model

        agent = DatawiseBaselineAgent(max_iterations=2)
        response, trace = agent.run_analysis_for_eval("Compute the value.")

        assert response == "The answer is 42."
        assert any(entry.get("role") == "tool" for entry in trace)
        assert (
            "/workspace/working/_datawise_cell.py"
            in mock_exec.call_args_list[1].args[0]
        )
        assert trace[2]["content"] == "42\n"
        assert mock_start.call_count == 1
        assert mock_stop.call_count == 1

    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.datawise.get_model")
    def test_includes_workspace_files_and_task_instructions(
        self,
        mock_get_model: MagicMock,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_exec: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_exec.return_value = ""
        model = MagicMock()
        model.invoke.return_value = AIMessage(content="<end_step>\nDone")
        mock_get_model.return_value = model
        data_file = tmp_path / "data.csv"
        data_file.write_text("x\n1\n")

        agent = DatawiseBaselineAgent()
        agent.run_analysis_for_eval(
            "Analyze",
            files=[data_file],
            task_instructions="Return JSON only.",
        )

        user_message = model.invoke.call_args.args[0][1]
        assert "Return JSON only." in user_message.content
        assert "/workspace/input/0/data.csv" in user_message.content
        assert "./input" in user_message.content


class TestRunModelingForEval:
    @patch.object(DockerSandbox, "get_file")
    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.datawise.get_model")
    def test_returns_submission_path_from_work_dir(
        self,
        mock_get_model: MagicMock,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_exec: MagicMock,
        mock_get_file: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_exec.return_value = ""
        model = MagicMock()
        model.invoke.return_value = AIMessage(content="<end_step>\nDone")
        mock_get_model.return_value = model
        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("id,y\n1,0\n")
        work_dir = tmp_path / "work"

        agent = DatawiseBaselineAgent()
        result_path, trace = agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
            work_dir=work_dir,
        )

        assert result_path == work_dir / "submission.csv"
        assert trace[-1]["role"] == "assistant"
        mock_get_file.assert_called_once_with(
            "/workspace/submission.csv",
            work_dir / "submission.csv",
        )


class TestProtocolConformance:
    def test_satisfies_data_science_agent_protocol(self) -> None:
        agent = DatawiseBaselineAgent()

        assert agent.name == "datawise"
        assert hasattr(agent, "run_analysis_for_eval")
        assert hasattr(agent, "run_modeling_for_eval")
        assert agent.model_name == "deepseek-v4-flash"
