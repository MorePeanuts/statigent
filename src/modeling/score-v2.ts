import { keys, obj, str } from "../models/validation";
import type { ProtocolV2 } from "./protocol-v2";

export type EvaluationPartition =
  | "search-validation"
  | "search-training"
  | "confirmation-validation"
  | "confirmation-training"
  | "test";
export type ScoreV2 = {
  metric: string;
  direction: "minimize" | "maximize";
  value: number;
  protocol_sha256: string;
  scoring_version: "tabular-metrics-v2";
  metric_definition_sha256: string;
  evaluation_id: string;
  partition: EvaluationPartition;
  components: {
    target: string;
    metric: "roc-auc-v1";
    value: number;
    error: null;
  }[];
};
export function validateScoreV2(
  value: unknown,
  p: ProtocolV2,
  expected: { evaluation_id: string; partition: EvaluationPartition },
): ScoreV2 {
  const x = obj(value);
  keys(x, [
    "metric",
    "direction",
    "value",
    "protocol_sha256",
    "scoring_version",
    "metric_definition_sha256",
    "evaluation_id",
    "partition",
    "components",
  ]);
  if (
    x.metric !== p.metric.id ||
    x.direction !== p.metric.direction ||
    x.protocol_sha256 !== p.protocol_sha256 ||
    x.scoring_version !== p.scoring_version ||
    x.metric_definition_sha256 !== p.metric.definition_sha256 ||
    x.evaluation_id !== expected.evaluation_id ||
    !/^[a-f0-9]{64}$/.test(str(x.evaluation_id, "evaluation identity")) ||
    x.partition !== expected.partition ||
    typeof x.value !== "number" ||
    !Number.isFinite(x.value) ||
    (p.metric.minimum !== null && x.value < p.metric.minimum) ||
    (p.metric.maximum !== null && x.value > p.metric.maximum)
  )
    throw new Error("Invalid score metric/partition/identity/value");
  if (
    !Array.isArray(x.components) ||
    x.components.length !== (p.kind === "multilabel" ? p.targets.length : 0)
  )
    throw new Error("Invalid score target components");
  const components = x.components.map((value, index) => {
    const c = obj(value);
    keys(c, ["target", "metric", "value", "error"]);
    if (
      c.target !== p.targets[index]?.name ||
      c.metric !== "roc-auc-v1" ||
      c.error !== null ||
      typeof c.value !== "number" ||
      !Number.isFinite(c.value) ||
      c.value < 0 ||
      c.value > 1
    )
      throw new Error("Invalid per-target score");
    return {
      target: str(c.target, "target"),
      metric: "roc-auc-v1" as const,
      value: c.value,
      error: null,
    };
  });
  if (
    components.length &&
    Math.abs(
      components.reduce((sum, c) => sum + c.value, 0) / components.length -
        x.value,
    ) > 1e-12
  )
    throw new Error("Invalid target score aggregate");
  return {
    metric: p.metric.id,
    direction: p.metric.direction,
    value: x.value,
    protocol_sha256: p.protocol_sha256,
    scoring_version: p.scoring_version,
    metric_definition_sha256: p.metric.definition_sha256,
    ...expected,
    components,
  };
}
export function betterV2(score: ScoreV2, best: ScoreV2 | null): boolean {
  if (
    best &&
    (score.protocol_sha256 !== best.protocol_sha256 ||
      score.scoring_version !== best.scoring_version ||
      score.metric_definition_sha256 !== best.metric_definition_sha256 ||
      score.metric !== best.metric ||
      score.direction !== best.direction ||
      score.evaluation_id !== best.evaluation_id ||
      score.partition !== best.partition)
  )
    throw new Error("Incomparable scores");
  return (
    !best ||
    (score.direction === "minimize"
      ? score.value < best.value
      : score.value > best.value)
  );
}
