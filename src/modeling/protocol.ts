import { keys, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";

export type TaskKind = "regression" | "binary" | "multiclass";
export type Metric = "rmse" | "accuracy" | "roc_auc" | "log_loss";
type Definition =
  | {
      kind: "regression";
      metric: "rmse";
      direction: "minimize";
      output: "numeric";
    }
  | {
      kind: "binary" | "multiclass";
      metric: "accuracy";
      direction: "maximize";
      output: "label";
    }
  | {
      kind: "binary";
      metric: "roc_auc";
      direction: "maximize";
      output: "probabilities";
    }
  | {
      kind: "binary" | "multiclass";
      metric: "log_loss";
      direction: "minimize";
      output: "probabilities";
    };
export type Protocol = Definition & {
  version: 1;
  classes: string[];
  positive_class: string | null;
  prediction: { column: string; probability_columns: string[] };
  scoring_version: "tabular-metrics-v1";
  protocol_sha256: string;
};
export function definition(kind: unknown, metric: unknown): Definition {
  if (kind === "regression" && metric === "rmse")
    return { kind, metric, direction: "minimize", output: "numeric" };
  if (kind === "binary" || kind === "multiclass") {
    if (metric === "accuracy")
      return { kind, metric, direction: "maximize", output: "label" };
    if (metric === "log_loss")
      return { kind, metric, direction: "minimize", output: "probabilities" };
    if (kind === "binary" && metric === "roc_auc")
      return { kind, metric, direction: "maximize", output: "probabilities" };
  }
  throw new Error("Unsupported tabular task/metric combination");
}
export const byteOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
export function createProtocol(
  kind: unknown,
  metric: unknown,
  labels: string[],
  positive: unknown,
  id: string,
): Protocol {
  const d = definition(kind, metric);
  const classes =
    d.kind === "regression"
      ? []
      : [...new Set(labels.map((v) => str(v, "class label")))].sort(byteOrder);
  if (
    (d.kind === "binary" && classes.length !== 2) ||
    (d.kind === "multiclass" && classes.length < 3)
  )
    throw new Error("Task kind/class count mismatch");
  const positive_class =
    d.kind === "binary" ? str(positive, "positive_class") : null;
  if (
    positive_class !== null
      ? !classes.includes(positive_class)
      : positive !== undefined && positive !== null
  )
    throw new Error("Invalid positive_class");
  const used = new Set([id]);
  const name = (base: string) => {
    let n = base;
    while (used.has(n)) n += "_";
    used.add(n);
    return n;
  };
  const prediction = {
    column: name("prediction"),
    probability_columns:
      d.output === "probabilities"
        ? classes.map((_, i) => name(`probability_${i}`))
        : [],
  };
  const content = {
    version: 1 as const,
    ...d,
    classes,
    positive_class,
    prediction,
    scoring_version: "tabular-metrics-v1" as const,
  };
  return {
    ...content,
    protocol_sha256: sha256(Buffer.from(JSON.stringify(content))),
  };
}
export function validateProtocol(value: unknown, id: string): Protocol {
  const x = obj(value);
  keys(x, [
    "version",
    "kind",
    "metric",
    "direction",
    "output",
    "classes",
    "positive_class",
    "prediction",
    "scoring_version",
    "protocol_sha256",
  ]);
  const p = createProtocol(
    x.kind,
    x.metric,
    strings(x.classes, "classes"),
    x.positive_class,
    id,
  );
  // Canonical fields also prevent duplicate/reordered class lists and silent numerical rule changes.
  for (const k of Object.keys(p) as (keyof Protocol)[])
    if (JSON.stringify(x[k]) !== JSON.stringify(p[k]))
      throw new Error(`Invalid protocol ${k}`);
  return p;
}
export interface Score {
  metric: Metric;
  direction: "minimize" | "maximize";
  value: number;
  protocol_sha256: string;
  scoring_version: string;
}
export function validateScore(value: unknown, p: Protocol): Score {
  const x = obj(value);
  keys(x, [
    "metric",
    "direction",
    "value",
    "protocol_sha256",
    "scoring_version",
  ]);
  if (
    x.metric !== p.metric ||
    x.direction !== p.direction ||
    x.protocol_sha256 !== p.protocol_sha256 ||
    x.scoring_version !== p.scoring_version ||
    typeof x.value !== "number" ||
    !Number.isFinite(x.value) ||
    x.value < 0 ||
    ((p.metric === "accuracy" || p.metric === "roc_auc") && x.value > 1)
  )
    throw new Error("Invalid score protocol or value");
  return {
    metric: p.metric,
    direction: p.direction,
    value: x.value,
    protocol_sha256: p.protocol_sha256,
    scoring_version: p.scoring_version,
  };
}
export function better(score: Score, best: Score | null): boolean {
  if (
    best &&
    (score.protocol_sha256 !== best.protocol_sha256 ||
      score.metric !== best.metric ||
      score.direction !== best.direction ||
      score.scoring_version !== best.scoring_version)
  )
    throw new Error("Incomparable scores");
  return (
    !best ||
    (score.direction === "minimize"
      ? score.value < best.value
      : score.value > best.value)
  );
}
