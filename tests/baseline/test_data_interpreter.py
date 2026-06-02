from pathlib import Path
from unittest.mock import MagicMock, patch

from langchain.messages import AIMessage

from statigent.baseline.data_interpreter import (
    DataInterpreterBaselineAgent,
    _extract_python_code_block,
)
from statigent.sandbox.docker import DockerSandbox


class TestExtractPythonCodeBlock:
    def test_extracts_first_python_fenced_block(self) -> None:
        content = "Thought\n```python\nprint(1)\n```\n```python\nprint(2)\n```"

        code = _extract_python_code_block(content)

        assert code == "print(1)"

    def test_returns_empty_when_no_python_block(self) -> None:
        assert _extract_python_code_block("No code") == ""


class TestDataInterpreterBaselineAgentInit:
    def test_default_params(self) -> None:
        agent = DataInterpreterBaselineAgent()

        assert agent.name == "data_interpreter"
        assert agent.model_name == "deepseek-v4-flash"
        assert agent.sandbox_image == "statigent/ds-sandbox"
        assert agent.sandbox_network is False
        assert agent.sandbox_timeout == 600
        assert agent.max_tasks == 4
        assert agent.max_retries == 3


class TestRunAnalysisForEval:
    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.data_interpreter.get_model")
    def test_plans_writes_code_executes_and_returns_final_answer(
        self,
        mock_get_model: MagicMock,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_exec: MagicMock,
    ) -> None:
        mock_exec.side_effect = ["", "42\n"]
        model = MagicMock()
        model.invoke.side_effect = [
            AIMessage(content="1. Compute value\n2. Answer"),
            AIMessage(content="```python\nprint(6 * 7)\n```"),
            AIMessage(content="The answer is 42."),
        ]
        mock_get_model.return_value = model

        agent = DataInterpreterBaselineAgent(max_tasks=1)
        response, trace = agent.run_analysis_for_eval("Compute the value.")

        assert response == "The answer is 42."
        assert [entry["name"] for entry in trace if "name" in entry] == [
            "plan",
            "write_code",
            "execute_code",
            "final_answer",
        ]
        assert "/workspace/working/_data_interpreter_cell.py" in (
            mock_exec.call_args_list[1].args[0]
        )
        assert mock_start.call_count == 1
        assert mock_stop.call_count == 1

    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.data_interpreter.get_model")
    def test_uses_reflection_after_failed_execution(
        self,
        mock_get_model: MagicMock,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_exec: MagicMock,
    ) -> None:
        mock_exec.side_effect = ["", "Exit code: 1\nNameError: x", "42\n"]
        model = MagicMock()
        model.invoke.side_effect = [
            AIMessage(content="1. Compute value"),
            AIMessage(content="```python\nprint(x)\n```"),
            AIMessage(content="```python\nprint(6 * 7)\n```"),
            AIMessage(content="The answer is 42."),
        ]
        mock_get_model.return_value = model

        agent = DataInterpreterBaselineAgent(max_tasks=1, max_retries=2)
        response, trace = agent.run_analysis_for_eval("Compute the value.")

        assert response == "The answer is 42."
        code_events = [
            entry
            for entry in trace
            if entry.get("name") in {"write_code", "reflect_code"}
        ]
        assert code_events[0]["name"] == "write_code"
        assert code_events[1]["name"] == "reflect_code"

    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.data_interpreter.get_model")
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
        model.invoke.side_effect = [
            AIMessage(content="1. Inspect data"),
            AIMessage(content="```python\nprint('done')\n```"),
            AIMessage(content="Done"),
        ]
        mock_get_model.return_value = model
        data_file = tmp_path / "data.csv"
        data_file.write_text("x\n1\n")

        agent = DataInterpreterBaselineAgent(max_tasks=1)
        agent.run_analysis_for_eval(
            "Analyze",
            files=[data_file],
            task_instructions="Return JSON only.",
        )

        plan_prompt = model.invoke.call_args_list[0].args[0][1].content
        assert "Return JSON only." in plan_prompt
        assert "/workspace/input/0/data.csv" in plan_prompt
        assert "./input" in plan_prompt

    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.data_interpreter.get_model")
    def test_missing_code_block_does_not_abort_benchmark(
        self,
        mock_get_model: MagicMock,
        mock_stop: MagicMock,
        mock_start: MagicMock,
        mock_exec: MagicMock,
    ) -> None:
        mock_exec.return_value = ""
        model = MagicMock()
        model.invoke.side_effect = [
            AIMessage(content="1. Answer directly"),
            AIMessage(content="The answer is option b."),
            AIMessage(content="The answer is option b."),
        ]
        mock_get_model.return_value = model

        agent = DataInterpreterBaselineAgent(max_tasks=1)
        response, trace = agent.run_analysis_for_eval("Choose the answer.")

        assert response == "The answer is option b."
        assert any(entry.get("name") == "missing_code" for entry in trace)
        assert trace[-1]["name"] == "final_answer"


class TestRunModelingForEval:
    @patch.object(DockerSandbox, "get_file")
    @patch.object(DockerSandbox, "exec")
    @patch.object(DockerSandbox, "start")
    @patch.object(DockerSandbox, "stop")
    @patch("statigent.baseline.data_interpreter.get_model")
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
        model.invoke.side_effect = [
            AIMessage(content="1. Train model"),
            AIMessage(content="```python\nprint('saved')\n```"),
            AIMessage(content="Saved submission."),
        ]
        mock_get_model.return_value = model
        train = tmp_path / "train.csv"
        train.write_text("x,y\n1,2\n")
        test = tmp_path / "test.csv"
        test.write_text("x\n3\n")
        sample = tmp_path / "sample_submission.csv"
        sample.write_text("id,y\n1,0\n")
        work_dir = tmp_path / "work"

        agent = DataInterpreterBaselineAgent(max_tasks=1)
        result_path, trace = agent.run_modeling_for_eval(
            "Build a model",
            train_path=train,
            test_path=test,
            sample_submission_path=sample,
            work_dir=work_dir,
        )

        assert result_path == work_dir / "submission.csv"
        assert trace[-1]["name"] == "final_answer"
        mock_get_file.assert_called_once_with(
            "/workspace/submission.csv",
            work_dir / "submission.csv",
        )


class TestProtocolConformance:
    def test_satisfies_data_science_agent_protocol(self) -> None:
        agent = DataInterpreterBaselineAgent()

        assert agent.name == "data_interpreter"
        assert hasattr(agent, "run_analysis_for_eval")
        assert hasattr(agent, "run_modeling_for_eval")
        assert agent.model_name == "deepseek-v4-flash"
