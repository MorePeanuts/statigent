import registry from "../../python/statigent_modeling/metric_definitions.json";
import { integer, keys, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";

export type TaskKindV2 =
  | "regression"
  | "binary"
  | "multiclass"
  | "ordinal"
  | "multilabel";
export type PredictionForm =
  | "numeric"
  | "label"
  | "probabilities"
  | "multilabel-probabilities"
  | "ranked-labels";
export type TargetV2 = {
  name: string;
  classes: string[];
  positive_class: string | null;
  levels: number[] | null;
};
export type MetricDefinition = {
  id: string;
  kinds: string[];
  output: PredictionForm;
  direction: "minimize" | "maximize";
  minimum: number | null;
  maximum: number | null;
  parameters: Record<string, string | number | boolean>;
  definition_sha256: string;
};
export type ProtocolV2 = {
  version: 2;
  kind: TaskKindV2;
  id_column: string;
  feature_columns: string[];
  targets: TargetV2[];
  metric: MetricDefinition;
  output: PredictionForm;
  prediction: {
    targets: {
      target: string;
      value_column: string | null;
      probability_columns: string[];
      ranked_column: string | null;
    }[];
    probabilities_optional: boolean;
    probability_tolerance: "1e-6";
    ties: "frozen-class-order";
  };
  scoring_version: "tabular-metrics-v2";
  protocol_sha256: string;
};
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  throw new Error("Invalid canonical JSON value");
}
export function metricDefinition(id: unknown): MetricDefinition {
  const found = registry.definitions.find((definition) => definition.id === id);
  if (!found) throw new Error(`Unknown metric definition: ${String(id)}`);
  const output = choice(
    found.output,
    [
      "numeric",
      "label",
      "probabilities",
      "multilabel-probabilities",
      "ranked-labels",
    ],
    "metric output",
  );
  const direction = choice(
    found.direction,
    ["minimize", "maximize"],
    "metric direction",
  );
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(found.parameters)) {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      typeof value !== "number"
    )
      throw new Error("Invalid metric parameter");
    parameters[key] = value;
  }
  const definition = { ...found, output, direction, parameters };
  return {
    ...definition,
    definition_sha256: sha256(Buffer.from(canonicalJson(definition))),
  };
}
function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  for (const item of allowed) if (value === item) return item;
  throw new Error(`Invalid ${label}`);
}
function unique(value: unknown, label: string, nonempty = false): string[] {
  const result = strings(value, label);
  if ((nonempty && !result.length) || new Set(result).size !== result.length)
    throw new Error(`Empty or duplicate ${label}`);
  return result;
}
export function createProtocolV2(value: unknown): ProtocolV2 {
  const input = obj(value);
  keys(input, ["kind", "metric_id", "targets", "id_column", "feature_columns"]);
  const kind = choice(
    input.kind,
    ["regression", "binary", "multiclass", "ordinal", "multilabel"],
    "task kind",
  );
  const metric = metricDefinition(input.metric_id);
  if (!metric.kinds.includes(kind))
    throw new Error("Unsupported task/metric combination");
  const id = str(input.id_column, "id column"),
    features = unique(input.feature_columns, "features", true);
  if (
    !Array.isArray(input.targets) ||
    (kind === "multilabel"
      ? input.targets.length < 2
      : input.targets.length !== 1)
  )
    throw new Error("Invalid targets");
  const targets = input.targets.map((value): TargetV2 => {
    const t = obj(value);
    keys(t, ["name", "classes", "positive_class", "levels"]);
    const name = str(t.name, "target name"),
      classes = unique(t.classes, "classes", kind !== "regression");
    if (
      (kind === "regression" && classes.length) ||
      ((kind === "binary" || kind === "multilabel") && classes.length !== 2) ||
      ((kind === "multiclass" || kind === "ordinal") && classes.length < 3)
    )
      throw new Error("Invalid target class count");
    const positive =
      t.positive_class === null
        ? null
        : str(t.positive_class, "positive class");
    if (kind === "binary" || kind === "multilabel") {
      if (positive === null || !classes.includes(positive))
        throw new Error("Invalid positive class");
    } else if (positive !== null) throw new Error("Unexpected positive class");
    let levels: number[] | null = null;
    if (kind === "ordinal") {
      if (!Array.isArray(t.levels) || t.levels.length !== classes.length)
        throw new Error("Invalid ordinal coordinates");
      levels = t.levels.map((v) => integer(v, "ordinal coordinate", 0));
      if (new Set(levels).size !== levels.length || levels.some((v) => v >= 10))
        throw new Error("Invalid ordinal coordinates");
    } else if (t.levels !== null)
      throw new Error("Unexpected ordinal coordinates");
    return { name, classes, positive_class: positive, levels };
  });
  const targetNames = targets.map((t) => t.name);
  if (
    new Set(targetNames).size !== targetNames.length ||
    targetNames.includes(id) ||
    features.some((f) => f === id || targetNames.includes(f))
  )
    throw new Error("Feature/target/identity overlap");
  const used = new Set([id, ...features, ...targetNames]);
  const column = (base: string) => {
    let name = base;
    while (used.has(name)) name += "_";
    used.add(name);
    return name;
  };
  const output = metric.output;
  const prediction: ProtocolV2["prediction"] = {
    targets: targets.map((target, index) => ({
      target: target.name,
      value_column:
        output === "ranked-labels" ? null : column(`prediction_${index}`),
      probability_columns: [
        "probabilities",
        "multilabel-probabilities",
        "ranked-labels",
      ].includes(output)
        ? target.classes.map((_, c) => column(`probability_${index}_${c}`))
        : [],
      ranked_column:
        output === "ranked-labels" ? column(`ranked_${index}`) : null,
    })),
    probabilities_optional: output === "ranked-labels",
    probability_tolerance: "1e-6",
    ties: "frozen-class-order",
  };
  const content = {
    version: 2 as const,
    kind,
    id_column: id,
    feature_columns: features,
    targets,
    metric,
    output,
    prediction,
    scoring_version: "tabular-metrics-v2" as const,
  };
  return {
    ...content,
    protocol_sha256: sha256(Buffer.from(canonicalJson(content))),
  };
}
export function validateProtocolV2(value: unknown, id?: string): ProtocolV2 {
  const raw = obj(value);
  keys(raw, [
    "version",
    "kind",
    "id_column",
    "feature_columns",
    "targets",
    "metric",
    "output",
    "prediction",
    "scoring_version",
    "protocol_sha256",
  ]);
  if (raw.version !== 2 || (id !== undefined && raw.id_column !== id))
    throw new Error("Invalid protocol version/identity");
  const expected = createProtocolV2({
    kind: raw.kind,
    metric_id: obj(raw.metric).id,
    id_column: raw.id_column,
    feature_columns: raw.feature_columns,
    targets: raw.targets,
  });
  if (canonicalJson(raw) !== canonicalJson(expected))
    throw new Error("Protocol identity/parameters mismatch");
  return expected;
}
export function predictionColumnsV2(
  p: ProtocolV2,
  includeOptional = true,
): string[] {
  return [
    p.id_column,
    ...p.prediction.targets.flatMap((t) => [
      ...(t.value_column ? [t.value_column] : []),
      ...(t.ranked_column ? [t.ranked_column] : []),
      ...(includeOptional || !p.prediction.probabilities_optional
        ? t.probability_columns
        : []),
    ]),
  ];
}
