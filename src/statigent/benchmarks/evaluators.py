import re
from typing import Any

from langchain.chat_models import BaseChatModel
from langchain.messages import HumanMessage
from loguru import logger
from pydantic import BaseModel, Field

from statigent.benchmarks.base import Evaluator, ScoreResult
from statigent.errors import StatigentParseError
from statigent.models import get_model
from statigent.retry import (
    invoke_structured_with_retries,
    retry_on_conn_error,
    retry_on_parse_error,
)

_ANSWER_PATTERN = re.compile(r"@(\w+)\[(.*?)\]")


def _extract_format(input_string: str) -> tuple[list[str], list[str]]:
    """Extract answer_name and answer value pairs from @name[value] format."""
    matches = _ANSWER_PATTERN.findall(input_string)
    names = [m[0] for m in matches]
    values = [m[1] for m in matches]
    return names, values


def _is_equal(response: str, label: str) -> bool:
    """Compare two answers: exact string match or float within 1e-6."""
    if response == label:
        return True
    try:
        return abs(float(response) - float(label)) < 1e-6
    except (ValueError, TypeError):
        return False


class DABenchExactMatchEvaluator(Evaluator):
    """Closed-form exact-match evaluator for DABench-style benchmarks."""

    def evaluate(self, predictions: Any, references: Any) -> ScoreResult:
        labels: list[dict[str, Any]] = references
        responses: list[dict[str, Any]] = predictions

        response_map = {r["id"]: r["response"] for r in responses}

        results: list[dict[str, Any]] = []
        for label in labels:
            qid = label["id"]
            if qid not in response_map:
                continue

            pred_names, pred_values = _extract_format(response_map[qid])
            pred_map = dict(zip(pred_names, pred_values, strict=True))

            correctness: dict[str, bool] = {}
            label_answers: dict[str, str] = {}
            for name, value in label["common_answers"]:
                label_answers[name] = value
                correctness[name] = _is_equal(pred_map.get(name, ""), value)

            results.append(
                {
                    "id": qid,
                    "label_answers": label_answers,
                    "predicted_answers": pred_map,
                    "correctness": correctness,
                }
            )

        if not results:
            return ScoreResult(
                score={"ABQ": 0.0, "PSAQ": 0.0, "UASQ": 0.0},
                details={},
                total_tasks=len(responses),
            )

        abq = self._accuracy_by_question(results)
        psaq = self._accuracy_proportional(results)
        uasq = self._accuracy_by_sub_question(results)

        return ScoreResult(
            score={"ABQ": abq, "PSAQ": psaq, "UASQ": uasq},
            details={
                "per_question": results,
            },
            total_tasks=len(responses),
        )

    @staticmethod
    def _accuracy_by_question(results: list[dict[str, Any]]) -> float:
        correct = sum(1 for r in results if all(r["correctness"].values()))
        return round(correct / len(results), 4)

    @staticmethod
    def _accuracy_proportional(results: list[dict[str, Any]]) -> float:
        scores: list[float] = []
        for r in results:
            vals = list(r["correctness"].values())
            scores.append(sum(vals) / len(vals))
        return round(sum(scores) / len(scores), 4)

    @staticmethod
    def _accuracy_by_sub_question(results: list[dict[str, Any]]) -> float:
        total = 0
        correct = 0
        for r in results:
            vals = list(r["correctness"].values())
            total += len(vals)
            correct += sum(vals)
        return round(correct / total, 4)


_JUDGE_PROMPT = (
    "Please judge whether the generated answer is right or wrong. "
    "We require that the correct answer to the prediction gives a clear answer, "
    "not just a calculation process or a disassembly of ideas. "
    "The question is {question}. The true answer is {answer}. "
    "The predicted answer is {prediction}. "
    "Judge whether the predicted answer is correct based on the true answer."
)


class JudgeVerdict(BaseModel):
    """Structured verdict from LLM judge."""

    is_correct: bool = Field(description="Whether the predicted answer is correct")


class DSBenchDAJudgeEvaluator(Evaluator):
    """LLM-as-judge evaluator for DSBench data-analysis tasks."""

    def __init__(self, judge_model_name: str = "deepseek-v4-flash") -> None:
        self.judge_model_name = judge_model_name
        self._structured_llm: Any = None

    def _get_structured_llm(self) -> Any:
        if self._structured_llm is None:
            llm = get_model(self.judge_model_name)
            self._structured_llm = llm.with_structured_output(
                JudgeVerdict, include_raw=True
            )
        return self._structured_llm

    def _invoke_structured(self, messages: list[Any]) -> JudgeVerdict:
        parsed = invoke_structured_with_retries(self._get_structured_llm(), messages)
        if not isinstance(parsed, JudgeVerdict):
            raise StatigentParseError(
                f"Expected JudgeVerdict, got {type(parsed).__name__}"
            )
        return parsed

    def evaluate(self, predictions: Any, references: Any) -> ScoreResult:
        refs: list[dict[str, Any]] = references
        preds: list[dict[str, Any]] = predictions

        pred_map = {p["id"]: p["response"] for p in preds}

        verdicts: list[bool] = []
        details: list[dict[str, Any]] = []
        for ref in refs:
            qid = ref["id"]
            if qid not in pred_map:
                continue
            prompt = _JUDGE_PROMPT.format(
                question=ref["question"],
                answer=ref["answer"],
                prediction=pred_map[qid],
            )
            try:
                verdict = retry_on_parse_error(self._invoke_structured)(
                    [HumanMessage(content=prompt)]
                )
                is_correct = verdict.is_correct
                text = verdict.model_dump_json()
            except StatigentParseError:
                logger.exception("LLM judge gave up for id={}", qid)
                is_correct = False
                text = ""
            verdicts.append(is_correct)
            details.append(
                {
                    "id": qid,
                    "question": ref["question"],
                    "answer": ref["answer"],
                    "prediction": pred_map[qid],
                    "verdict": is_correct,
                    "verdict_json": text,
                }
            )
            logger.debug("LLM judge for id={}: verdict={}", qid, is_correct)

        accuracy = sum(verdicts) / len(verdicts) if verdicts else 0.0
        tlacc = round(accuracy, 4)
        return ScoreResult(
            score={"TLAcc": tlacc, "CLAcc": tlacc},
            details={
                "accuracy": accuracy,
                "per_question": details,
            },
            total_tasks=len(preds),
            others={"judged_tasks": len(verdicts)},
        )


_REFORMAT_TEMPLATE = (
    "Please reformat the following response to match the required format. "
    "The required format is: {format_template}\n"
    "The original question was: {question}\n"
    "The assistant's response was: {response}\n"
    "Please output the response using the @answer_name[answer] format. "
    "Only output the reformatted answer, nothing else."
)


class ReformatEvaluator:
    """Post-processor that uses an LLM to reformat agent responses."""

    def __init__(self, model_name: str = "deepseek-v4-flash") -> None:
        self.model_name = model_name
        self._llm: BaseChatModel | None = None

    def _get_llm(self) -> BaseChatModel:
        if self._llm is None:
            self._llm = get_model(self.model_name)
        return self._llm

    def reformat(
        self,
        responses: list[dict[str, Any]],
        questions: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Reformat agent responses into @name[value] format using LLM."""
        question_map = {q["id"]: q for q in questions}
        llm = self._get_llm()
        reformatted = []

        for resp in responses:
            qid = resp["id"]
            question = question_map.get(qid)
            if question is None:
                reformatted.append(resp)
                continue

            prompt = _REFORMAT_TEMPLATE.format(
                format_template=question.get("format", ""),
                question=question.get("question", ""),
                response=resp["response"],
            )
            response = retry_on_conn_error(llm.invoke)([HumanMessage(content=prompt)])
            content = response.content
            text = content if isinstance(content, str) else str(content)
            reformatted.append({"id": qid, "response": text})
            logger.debug("Reformatted id={}", qid)

        return reformatted
