from unittest.mock import MagicMock, patch

import pytest

from statigent.benchmarks.evaluators import (
    ExactMatchEvaluator,
    JudgeVerdict,
    LLMJudgeEvaluator,
    ReformatEvaluator,
)


class TestExactMatchEvaluator:
    def test_exact_string_match(self):
        evaluator = ExactMatchEvaluator()
        labels = [{"id": 0, "common_answers": [["count", "891"]]}]
        responses = [{"id": 0, "response": "@count[891]"}]
        result = evaluator.evaluate(responses, labels)
        assert result.score > 0

    def test_float_tolerance_match(self):
        evaluator = ExactMatchEvaluator()
        labels = [{"id": 0, "common_answers": [["mean_fare", "34.65"]]}]
        responses = [{"id": 0, "response": "@mean_fare[34.6500001]"}]
        result = evaluator.evaluate(responses, labels)
        assert result.score > 0

    def test_wrong_answer(self):
        evaluator = ExactMatchEvaluator()
        labels = [{"id": 0, "common_answers": [["count", "891"]]}]
        responses = [{"id": 0, "response": "@count[100]"}]
        result = evaluator.evaluate(responses, labels)
        assert result.score == 0.0

    def test_missing_response_skipped(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {"id": 0, "common_answers": [["count", "891"]]},
            {"id": 1, "common_answers": [["total", "100"]]},
        ]
        responses = [{"id": 0, "response": "@count[891]"}]
        result = evaluator.evaluate(responses, labels)
        assert result.details["abq"] == 1.0
        assert result.details["total_questions"] == 1

    def test_multi_answer_question(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {
                "id": 0,
                "common_answers": [
                    ["mean_fare_child", "31.09"],
                    ["mean_fare_teenager", "31.98"],
                ],
            }
        ]
        responses = [
            {"id": 0, "response": "@mean_fare_child[31.09], @mean_fare_teenager[31.98]"}
        ]
        result = evaluator.evaluate(responses, labels)
        assert result.score > 0

    def test_multi_answer_partial_wrong(self):
        evaluator = ExactMatchEvaluator()
        labels = [
            {
                "id": 0,
                "common_answers": [
                    ["mean_fare_child", "31.09"],
                    ["mean_fare_teenager", "31.98"],
                ],
            }
        ]
        responses = [
            {"id": 0, "response": "@mean_fare_child[31.09], @mean_fare_teenager[999]"}
        ]
        result = evaluator.evaluate(responses, labels)
        assert result.details["abq"] == 0.0
        assert result.details["psaq"] == pytest.approx(0.5, abs=1e-4)
        assert result.details["uasq"] == pytest.approx(0.5, abs=1e-4)


class TestLLMJudgeEvaluator:
    @patch("statigent.benchmarks.evaluators.get_model")
    def test_judge_returns_true(self, mock_get_model: MagicMock):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = JudgeVerdict(is_correct=True)
        mock_llm.with_structured_output.return_value = mock_structured
        mock_get_model.return_value = mock_llm

        evaluator = LLMJudgeEvaluator(judge_model_name="deepseek-v4-flash")
        result = evaluator.evaluate(
            predictions=[{"id": "1", "response": "The answer is 42"}],
            references=[{"id": "1", "answer": "42", "question": "What is 6*7?"}],
        )
        assert result.score > 0

    @patch("statigent.benchmarks.evaluators.get_model")
    def test_judge_returns_false(self, mock_get_model: MagicMock):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = JudgeVerdict(is_correct=False)
        mock_llm.with_structured_output.return_value = mock_structured
        mock_get_model.return_value = mock_llm

        evaluator = LLMJudgeEvaluator(judge_model_name="deepseek-v4-flash")
        result = evaluator.evaluate(
            predictions=[{"id": "1", "response": "The answer is 99"}],
            references=[{"id": "1", "answer": "42", "question": "What is 6*7?"}],
        )
        assert result.score == 0.0

    @patch("statigent.benchmarks.evaluators.time.sleep")
    @patch("statigent.benchmarks.evaluators.get_model")
    def test_judge_retries_on_failure_then_succeeds(
        self, mock_get_model: MagicMock, mock_sleep: MagicMock
    ):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.side_effect = [
            ValueError("parse error"),
            JudgeVerdict(is_correct=True),
        ]
        mock_llm.with_structured_output.return_value = mock_structured
        mock_get_model.return_value = mock_llm

        evaluator = LLMJudgeEvaluator(judge_model_name="deepseek-v4-flash")
        result = evaluator.evaluate(
            predictions=[{"id": "1", "response": "The answer is 42"}],
            references=[{"id": "1", "answer": "42", "question": "What is 6*7?"}],
        )
        assert result.score > 0
        assert mock_structured.invoke.call_count == 2
        mock_sleep.assert_called_once_with(1)

    @patch("statigent.benchmarks.evaluators.time.sleep")
    @patch("statigent.benchmarks.evaluators.get_model")
    def test_judge_retries_exhausted_defaults_false(
        self, mock_get_model: MagicMock, mock_sleep: MagicMock
    ):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.side_effect = ValueError("parse error")
        mock_llm.with_structured_output.return_value = mock_structured
        mock_get_model.return_value = mock_llm

        evaluator = LLMJudgeEvaluator(judge_model_name="deepseek-v4-flash")
        result = evaluator.evaluate(
            predictions=[{"id": "1", "response": "The answer is 42"}],
            references=[{"id": "1", "answer": "42", "question": "What is 6*7?"}],
        )
        assert result.score == 0.0
        assert mock_structured.invoke.call_count == LLMJudgeEvaluator._MAX_RETRIES


class TestReformatEvaluator:
    @patch("statigent.benchmarks.evaluators.get_model")
    def test_reformat_calls_llm(self, mock_get_model: MagicMock):
        mock_llm = MagicMock()
        mock_response = MagicMock()
        mock_response.content = "@count[891]"
        mock_llm.invoke.return_value = mock_response
        mock_get_model.return_value = mock_llm

        evaluator = ReformatEvaluator(model_name="deepseek-v4-flash")
        questions = [{"id": 0, "format": "@count[count]"}]
        responses = [{"id": 0, "response": "The total count is 891"}]
        result = evaluator.reformat(responses, questions)
        assert len(result) == 1
        assert "@count[891]" in result[0]["response"]
