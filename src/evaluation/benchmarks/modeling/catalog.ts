import { posix } from "node:path";
import * as z from "zod";

export const MODELING_BENCHMARKS = [
  "dsbench-modeling",
  "tabarena-lite",
] as const;
export type ModelingBenchmark = (typeof MODELING_BENCHMARKS)[number];

// 目录是受版本约束的实验输入；未知字段必须报错，不能被解析器静默丢弃。
const nonemptyString = z.string().refine((value) => value.trim().length > 0);
const safeInteger = z.number().refine(Number.isSafeInteger);
const stringList = z.array(nonemptyString);
const fileSchema = z.strictObject({
  path: nonemptyString,
  sha256: nonemptyString,
  bytes: safeInteger.nonnegative(),
  access: z.enum(["description", "training", "prediction", "evaluator", "raw"]),
});
const protocolSchema = z.strictObject({
  kind: z.enum(["regression", "binary", "multiclass", "ordinal", "multilabel"]),
  targets: stringList,
  excluded_columns: stringList,
  feature_columns: stringList,
  identity: z.strictObject({
    strategy: z.enum(["source-column", "source-row"]),
    column: nonemptyString.nullable(),
  }),
  metric: z.strictObject({
    id: nonemptyString,
    direction: z.enum(["minimize", "maximize"]),
  }),
  prediction_columns: stringList,
  prediction_form: z.enum([
    "numeric",
    "label",
    "probabilities",
    "ranked-labels",
    "multilabel-probabilities",
  ]),
  scorer: fileSchema,
});
const stageSchema = z.strictObject({
  status: z.enum(["not_run", "passed", "failed", "blocked"]),
  evidence: stringList,
});
const taskSchema = z.strictObject({
  benchmark: z.enum(MODELING_BENCHMARKS),
  task_id: nonemptyString,
  source_revision: nonemptyString,
  code_revision: nonemptyString.nullable(),
  openml: z
    .strictObject({
      dataset_id: nonemptyString,
      version: safeInteger.positive(),
      repeat: z.literal(0),
      fold: z.literal(0),
    })
    .nullable(),
  files: z.array(fileSchema),
  outer_split: nonemptyString,
  protocol: protocolSchema.nullable(),
  issues: stringList,
  research: z.strictObject({
    status: z.enum(["eligible", "review_required", "excluded"]),
    reasons: stringList,
  }),
  adaptation: z.strictObject({
    status: z.enum(["ready", "blocked"]),
    reasons: stringList,
  }),
  acceptance: z.strictObject({
    preflight: stageSchema,
    deterministic: stageSchema,
    live: stageSchema,
  }),
});
const catalogSchema = z.strictObject({
  schema_version: z.literal(1),
  tasks: z.array(taskSchema),
});

export type CatalogFile = z.infer<typeof fileSchema>;
export type CatalogProtocol = z.infer<typeof protocolSchema>;
export type CatalogTask = z.infer<typeof taskSchema>;
export type ModelingCatalog = z.infer<typeof catalogSchema>;

function unique(value: string[], label: string, nonempty = false): string[] {
  if ((nonempty && !value.length) || new Set(value).size !== value.length)
    throw new Error(`Empty or duplicate ${label}`);
  return value;
}
function file(value: CatalogFile): CatalogFile {
  const { path, sha256 } = value;
  if (
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.startsWith("../") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    throw new Error("Unsafe catalog path");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid catalog sha256");
  return value;
}
function protocol(value: CatalogProtocol): CatalogProtocol {
  const { strategy, column } = value.identity;
  if ((strategy === "source-row") !== (column === null))
    throw new Error("Invalid identity column");
  const targets = unique(value.targets, "targets", true),
    excluded = unique(value.excluded_columns, "excluded columns"),
    features = unique(value.feature_columns, "feature columns", true);
  if (
    features.some(
      (name) =>
        targets.includes(name) || excluded.includes(name) || name === column,
    )
  )
    throw new Error("Target/identity leakage in features");
  if (value.kind === "multilabel" ? targets.length < 2 : targets.length !== 1)
    throw new Error("Invalid target count");
  unique(value.prediction_columns, "prediction columns", true);
  file(value.scorer);
  return value;
}
export function parseModelingCatalog(value: unknown): ModelingCatalog {
  const raw = catalogSchema.parse(value);
  const seen = new Set<string>();
  for (const task of raw.tasks) {
    if (!/^[a-zA-Z0-9_-]+$/.test(task.task_id))
      throw new Error("Invalid task id");
    const identity = `${task.benchmark}/${task.task_id}`;
    if (seen.has(identity))
      throw new Error(`Duplicate catalog task: ${identity}`);
    seen.add(identity);
    const reasons = unique(
      task.adaptation.reasons,
      "adaptation reasons",
      task.adaptation.status === "blocked",
    );
    if (
      task.adaptation.status === "ready" &&
      (reasons.length || task.protocol === null)
    )
      throw new Error("Ready task has unresolved protocol/blockers");
    if (!task.files.length) throw new Error("Missing catalog sources");
    task.files.forEach(file);
    if (new Set(task.files.map((item) => item.path)).size !== task.files.length)
      throw new Error("Duplicate catalog file");
    if (
      task.code_revision !== null &&
      !/^[a-f0-9]{40}$/.test(task.code_revision)
    )
      throw new Error("Invalid code revision");
    if (task.benchmark === "tabarena-lite") {
      if (task.openml === null) throw new Error("Expected OpenML identity");
    } else if (task.openml !== null)
      throw new Error("Unexpected OpenML identity");
    if (task.protocol !== null) protocol(task.protocol);
    unique(task.issues, "issues");
    unique(
      task.research.reasons,
      "research reasons",
      task.research.status !== "eligible",
    );
    for (const stage of Object.values(task.acceptance)) {
      unique(stage.evidence, "acceptance evidence", stage.status !== "not_run");
      if (stage.status === "not_run" && stage.evidence.length)
        throw new Error("Unexecuted acceptance has evidence");
    }
  }
  return raw;
}

/** 对照下载候选身份集合，而不只检查总数，防止同数量的误替换。 */
export function assertCatalogCoverage(
  catalog: ModelingCatalog,
  expected: Record<ModelingBenchmark, readonly string[]>,
): void {
  const wanted = new Set(
    Object.entries(expected).flatMap(([benchmark, ids]) =>
      ids.map((id) => `${benchmark}/${id}`),
    ),
  );
  const actual = new Set(
    catalog.tasks.map((task) => `${task.benchmark}/${task.task_id}`),
  );
  const missing = [...wanted].filter((id) => !actual.has(id)),
    extra = [...actual].filter((id) => !wanted.has(id));
  if (missing.length || extra.length)
    throw new Error(
      `Catalog coverage mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`,
    );
}
