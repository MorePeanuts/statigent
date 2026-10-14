import { posix } from "node:path";
import { integer, keys, obj, str, strings } from "../../../models/validation";

export const MODELING_BENCHMARKS = [
  "dsbench-modeling",
  "tabarena-lite",
] as const;
export type ModelingBenchmark = (typeof MODELING_BENCHMARKS)[number];
export type CatalogFile = {
  path: string;
  sha256: string;
  bytes: number;
  access: "description" | "training" | "prediction" | "evaluator" | "raw";
};
export type CatalogProtocol = {
  kind: "regression" | "binary" | "multiclass" | "ordinal" | "multilabel";
  targets: string[];
  excluded_columns: string[];
  feature_columns: string[];
  identity: { strategy: "source-column" | "source-row"; column: string | null };
  metric: { id: string; direction: "minimize" | "maximize" };
  prediction_columns: string[];
  prediction_form:
    | "numeric"
    | "label"
    | "probabilities"
    | "ranked-labels"
    | "multilabel-probabilities";
  scorer: CatalogFile;
};
export type CatalogTask = {
  benchmark: ModelingBenchmark;
  task_id: string;
  source_revision: string;
  code_revision: string | null;
  openml: { dataset_id: string; version: number; repeat: 0; fold: 0 } | null;
  files: CatalogFile[];
  outer_split: string;
  protocol: CatalogProtocol | null;
  issues: string[];
  research: {
    status: "eligible" | "review_required" | "excluded";
    reasons: string[];
  };
  adaptation: { status: "ready" | "blocked"; reasons: string[] };
  acceptance: Record<
    "preflight" | "deterministic" | "live",
    {
      status: "not_run" | "passed" | "failed" | "blocked";
      evidence: string[];
    }
  >;
};
export type ModelingCatalog = { schema_version: 1; tasks: CatalogTask[] };

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  for (const candidate of allowed) if (value === candidate) return candidate;
  throw new Error(`Invalid ${label}: ${String(value)}`);
}
function unique(value: unknown, label: string, nonempty = false): string[] {
  const result = strings(value, label);
  if ((nonempty && !result.length) || new Set(result).size !== result.length)
    throw new Error(`Empty or duplicate ${label}`);
  return result;
}
function file(value: unknown): CatalogFile {
  const raw = obj(value);
  keys(raw, ["path", "sha256", "bytes", "access"]);
  const path = str(raw.path, "catalog path"),
    sha256 = str(raw.sha256, "sha256");
  if (
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.startsWith("../") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    throw new Error("Unsafe catalog path");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid catalog sha256");
  return {
    path,
    sha256,
    bytes: integer(raw.bytes, "file bytes", 0),
    access: choice(
      raw.access,
      ["description", "training", "prediction", "evaluator", "raw"],
      "access",
    ),
  };
}
function protocol(value: unknown): CatalogProtocol {
  const raw = obj(value);
  keys(raw, [
    "kind",
    "targets",
    "excluded_columns",
    "feature_columns",
    "identity",
    "metric",
    "prediction_columns",
    "prediction_form",
    "scorer",
  ]);
  const identity = obj(raw.identity),
    metric = obj(raw.metric);
  keys(identity, ["strategy", "column"]);
  keys(metric, ["id", "direction"]);
  const strategy = choice(
    identity.strategy,
    ["source-column", "source-row"],
    "identity strategy",
  );
  const column =
    identity.column === null ? null : str(identity.column, "identity column");
  if ((strategy === "source-row") !== (column === null))
    throw new Error("Invalid identity column");
  const targets = unique(raw.targets, "targets", true),
    excluded = unique(raw.excluded_columns, "excluded columns"),
    features = unique(raw.feature_columns, "feature columns", true);
  if (
    features.some(
      (name) =>
        targets.includes(name) || excluded.includes(name) || name === column,
    )
  )
    throw new Error("Target/identity leakage in features");
  const kind = choice(
    raw.kind,
    ["regression", "binary", "multiclass", "ordinal", "multilabel"],
    "kind",
  );
  if (kind === "multilabel" ? targets.length < 2 : targets.length !== 1)
    throw new Error("Invalid target count");
  return {
    kind,
    targets,
    excluded_columns: excluded,
    feature_columns: features,
    identity: { strategy, column },
    metric: {
      id: str(metric.id, "metric id"),
      direction: choice(
        metric.direction,
        ["minimize", "maximize"],
        "direction",
      ),
    },
    prediction_columns: unique(
      raw.prediction_columns,
      "prediction columns",
      true,
    ),
    prediction_form: choice(
      raw.prediction_form,
      [
        "numeric",
        "label",
        "probabilities",
        "ranked-labels",
        "multilabel-probabilities",
      ],
      "prediction form",
    ),
    scorer: file(raw.scorer),
  };
}
export function parseModelingCatalog(value: unknown): ModelingCatalog {
  const raw = obj(value);
  keys(raw, ["schema_version", "tasks"]);
  if (raw.schema_version !== 1 || !Array.isArray(raw.tasks))
    throw new Error("Invalid modeling catalog version/tasks");
  const seen = new Set<string>();
  const tasks = raw.tasks.map((value): CatalogTask => {
    const task = obj(value);
    keys(task, [
      "benchmark",
      "task_id",
      "source_revision",
      "code_revision",
      "openml",
      "files",
      "outer_split",
      "protocol",
      "issues",
      "research",
      "adaptation",
      "acceptance",
    ]);
    const benchmark = choice(task.benchmark, MODELING_BENCHMARKS, "benchmark"),
      taskId = str(task.task_id, "task id");
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid task id");
    const identity = `${benchmark}/${taskId}`;
    if (seen.has(identity))
      throw new Error(`Duplicate catalog task: ${identity}`);
    seen.add(identity);
    const research = obj(task.research),
      adaptation = obj(task.adaptation),
      acceptance = obj(task.acceptance);
    keys(research, ["status", "reasons"]);
    keys(adaptation, ["status", "reasons"]);
    keys(acceptance, ["preflight", "deterministic", "live"]);
    const researchStatus = choice(
      research.status,
      ["eligible", "review_required", "excluded"],
      "research status",
    );
    const adaptationStatus = choice(
      adaptation.status,
      ["ready", "blocked"],
      "adaptation status",
    );
    const reasons = unique(
      adaptation.reasons,
      "adaptation reasons",
      adaptationStatus === "blocked",
    );
    if (
      adaptationStatus === "ready" &&
      (reasons.length || task.protocol === null)
    )
      throw new Error("Ready task has unresolved protocol/blockers");
    if (!Array.isArray(task.files) || !task.files.length)
      throw new Error("Missing catalog sources");
    const files = task.files.map(file);
    if (new Set(files.map((item) => item.path)).size !== files.length)
      throw new Error("Duplicate catalog file");
    const codeRevision =
      task.code_revision === null
        ? null
        : str(task.code_revision, "code revision");
    if (codeRevision !== null && !/^[a-f0-9]{40}$/.test(codeRevision))
      throw new Error("Invalid code revision");
    let openml: CatalogTask["openml"] = null;
    if (benchmark === "tabarena-lite") {
      const rawOpenml = obj(task.openml);
      keys(rawOpenml, ["dataset_id", "version", "repeat", "fold"]);
      if (rawOpenml.repeat !== 0 || rawOpenml.fold !== 0)
        throw new Error("Expected r0f0");
      openml = {
        dataset_id: str(rawOpenml.dataset_id, "OpenML dataset id"),
        version: integer(rawOpenml.version, "OpenML version"),
        repeat: 0,
        fold: 0,
      };
    } else if (task.openml !== null)
      throw new Error("Unexpected OpenML identity");
    function stage(name: "preflight" | "deterministic" | "live") {
      const rawStage = obj(acceptance[name]);
      keys(rawStage, ["status", "evidence"]);
      const status = choice(
        rawStage.status,
        ["not_run", "passed", "failed", "blocked"],
        "acceptance status",
      );
      const evidence = unique(
        rawStage.evidence,
        "acceptance evidence",
        status !== "not_run",
      );
      if (status === "not_run" && evidence.length)
        throw new Error("Unexecuted acceptance has evidence");
      return { status, evidence };
    }
    return {
      benchmark,
      task_id: taskId,
      source_revision: str(task.source_revision, "source revision"),
      code_revision: codeRevision,
      openml,
      files,
      outer_split: str(task.outer_split, "outer split"),
      protocol: task.protocol === null ? null : protocol(task.protocol),
      issues: unique(task.issues, "issues"),
      research: {
        status: researchStatus,
        reasons: unique(
          research.reasons,
          "research reasons",
          researchStatus !== "eligible",
        ),
      },
      adaptation: { status: adaptationStatus, reasons },
      acceptance: {
        preflight: stage("preflight"),
        deterministic: stage("deterministic"),
        live: stage("live"),
      },
    };
  });
  return { schema_version: 1, tasks };
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
