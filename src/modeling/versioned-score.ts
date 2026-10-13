import { type Protocol, type Score, validateScore } from "./protocol";
import type { ProtocolV2 } from "./protocol-v2";
import { type ScoreV2, validateScoreV2 } from "./score-v2";
import type { Evaluation } from "./validation";

export type ModelingProtocol = Protocol | ProtocolV2;
export type ModelingScore = Score | ScoreV2;
export const metricDirection = (p: ModelingProtocol) =>
  p.version === 2 ? p.metric.direction : p.direction;

export function validateEvaluationScore(
  value: unknown,
  p: ModelingProtocol,
  e: Evaluation,
) {
  if (e.phase === "final")
    throw new Error("Final fit cannot have an internal score");
  if (p.version === 1) return validateScore(value, p, e.evaluation_id);
  return validateScoreV2(value, p, {
    evaluation_id: e.evaluation_id,
    partition:
      e.phase === "search" ? "search-validation" : "confirmation-validation",
  });
}
