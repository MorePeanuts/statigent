import { type ModelProfile, validateProfile } from "../models/config";
import { integer, keys, obj, str, strings } from "../models/validation";
import { safeRelativePath, sha256 } from "../records/store";

// v2 is written for every new batch; v1 stays readable so earlier batches can be inspected and rescored.
export const VERSION = 2;
export type ContractVersion = 1 | 2;
export const LIMITS = {
  request: 262144,
  response: 8388608,
  stderr: 1048576,
  artifact: 1048576,
  artifacts: 4194304,
  record: 16777216,
  events: 16777216,
  deliverable: 8388608,
  deliverables: 33554432,
  deliverable_files: 64,
};
export function literal<T extends string>(
  value: unknown,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new Error(`Expected ${choices.join("|")}`);
  return value as T;
}
export function id(value: unknown): string {
  const result = str(value, "id");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(result) ||
    result.includes("..")
  )
    throw new Error("Invalid id");
  return result;
}
export function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid sha256");
  return value;
}
export function text(value: unknown, max = LIMITS.request): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max)
    throw new Error("Invalid or oversized text");
  return value;
}
export function bounded(value: unknown, max: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > max)
    throw new Error("Payload limit exceeded");
}
export function envelope(
  value: unknown,
  allowed: string[],
  versions: readonly ContractVersion[] = [VERSION],
): Record<string, unknown> {
  bounded(value, LIMITS.record);
  const x = obj(value);
  keys(x, ["schema_version", ...allowed]);
  if (!versions.includes(x.schema_version as ContractVersion))
    throw new Error("Unsupported schema_version");
  return x;
}
export function contractVersion(value: unknown): ContractVersion {
  const version = obj(value).schema_version;
  if (version !== 1 && version !== 2)
    throw new Error("Unsupported schema_version");
  return version;
}
export interface InputFile {
  path: string;
  sha256: string;
  bytes: number;
}
export type OutputKind = "text" | "report";
export type ImageType = "png" | "jpeg";
export type OutputContract =
  | { kind: "text"; instructions: string }
  | {
      kind: "report";
      instructions: string;
      report_file: string;
      image_types: ImageType[];
      max_images: number;
      max_image_bytes: number;
      max_report_bytes: number;
    };
export interface PublicTask {
  schema_version: 2;
  id: string;
  version: string;
  goal: string;
  constraints: string[];
  inputs: InputFile[];
  output: OutputContract;
}
export function validateOutput(
  value: unknown,
  version: ContractVersion,
): OutputContract {
  const o = obj(value);
  const kind = literal(o.kind, version === 1 ? ["text"] : ["text", "report"]);
  if (kind === "text") {
    keys(o, ["kind", "instructions"]);
    return { kind, instructions: str(o.instructions, "instructions") };
  }
  keys(o, [
    "kind",
    "instructions",
    "report_file",
    "image_types",
    "max_images",
    "max_image_bytes",
    "max_report_bytes",
  ]);
  const types = strings(o.image_types, "image_types").map((t) =>
    literal(t, ["png", "jpeg"] as const),
  );
  const result = {
    kind,
    instructions: str(o.instructions, "instructions"),
    report_file: safeRelativePath(str(o.report_file, "report_file")),
    image_types: types,
    max_images: integer(o.max_images, "max_images", 0),
    max_image_bytes: integer(o.max_image_bytes, "max_image_bytes"),
    max_report_bytes: integer(o.max_report_bytes, "max_report_bytes"),
  };
  if (
    !result.report_file.endsWith(".md") ||
    new Set(types).size !== types.length ||
    result.max_images + 1 > LIMITS.deliverable_files ||
    result.max_image_bytes > LIMITS.deliverable ||
    result.max_report_bytes > LIMITS.deliverable
  )
    throw new Error("Invalid report output contract");
  return result;
}
/** Reads v1 or v2 tasks and returns the v2 in-memory shape; files on disk are never upgraded. */
export function validateTask(value: unknown): PublicTask {
  bounded(value, LIMITS.request);
  const x = envelope(
    value,
    ["id", "version", "goal", "constraints", "inputs", "output"],
    [1, 2],
  );
  const version = contractVersion(x);
  // Some benchmark questions (DSBench reasoning cases) ship without data files; v1 never allowed that.
  if (!Array.isArray(x.inputs) || (version === 1 && x.inputs.length === 0))
    throw new Error("Inputs required");
  const inputs = x.inputs.map((v): InputFile => {
    const f = obj(v);
    keys(f, ["path", "sha256", "bytes"]);
    return {
      path: safeRelativePath(str(f.path, "path")),
      sha256: hash(f.sha256),
      bytes: integer(f.bytes, "bytes", 0),
    };
  });
  if (new Set(inputs.map((f) => f.path)).size !== inputs.length)
    throw new Error("Duplicate input path");
  return {
    schema_version: 2,
    id: id(x.id),
    version: str(x.version, "version"),
    goal: str(x.goal, "goal"),
    constraints: strings(x.constraints, "constraints"),
    inputs,
    output: validateOutput(x.output, version),
  };
}
export interface Budget {
  timeout_ms: number;
  model_attempts: number | null;
  total_tokens: number | null;
}
export function validateBudget(value: unknown): Budget {
  const x = obj(value);
  keys(x, ["timeout_ms", "model_attempts", "total_tokens"]);
  return {
    timeout_ms: integer(x.timeout_ms, "timeout_ms"),
    model_attempts:
      x.model_attempts === null
        ? null
        : integer(x.model_attempts, "model_attempts"),
    total_tokens:
      x.total_tokens === null ? null : integer(x.total_tokens, "total_tokens"),
  };
}
export interface Capabilities {
  schema_version: 2;
  outputs: OutputKind[];
  trajectory: "unified" | "none";
  model: "configurable" | "none";
  seed: "execution" | "unsupported";
  isolation: "docker";
  model_budget: boolean;
  usage: "measured" | "self_reported" | "not_applicable";
}
export function validateCapabilities(value: unknown): Capabilities {
  const x = envelope(value, [
    "outputs",
    "trajectory",
    "model",
    "seed",
    "isolation",
    "model_budget",
    "usage",
  ]);
  if (typeof x.model_budget !== "boolean")
    throw new Error("Invalid model_budget");
  const outputs = strings(x.outputs, "outputs").map((o) =>
    literal(o, ["text", "report"] as const),
  );
  if (!outputs.length || new Set(outputs).size !== outputs.length)
    throw new Error("Invalid output capabilities");
  const result: Capabilities = {
    schema_version: 2,
    outputs,
    trajectory: literal(x.trajectory, ["unified", "none"]),
    model: literal(x.model, ["configurable", "none"]),
    seed: literal(x.seed, ["execution", "unsupported"]),
    isolation: literal(x.isolation, ["docker"]),
    model_budget: x.model_budget,
    usage: literal(x.usage, ["measured", "self_reported", "not_applicable"]),
  };
  if ((result.model === "none") !== (result.usage === "not_applicable"))
    throw new Error("Inconsistent model usage capability");
  return result;
}
export interface Usage {
  source: "measured" | "self_reported" | "unknown" | "not_applicable";
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  unknown_attempts: number;
  currency_cost: "not_computed";
}
export function validateUsage(value: unknown): Usage {
  const x = obj(value);
  keys(x, [
    "source",
    "attempts",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "unknown_attempts",
    "currency_cost",
  ]);
  const u: Usage = {
    source: literal(x.source, [
      "measured",
      "self_reported",
      "unknown",
      "not_applicable",
    ]),
    attempts: integer(x.attempts, "attempts", 0),
    input_tokens: integer(x.input_tokens, "input_tokens", 0),
    output_tokens: integer(x.output_tokens, "output_tokens", 0),
    total_tokens: integer(x.total_tokens, "total_tokens", 0),
    unknown_attempts: integer(x.unknown_attempts, "unknown_attempts", 0),
    currency_cost: literal(x.currency_cost, ["not_computed"]),
  };
  if (
    u.total_tokens !== u.input_tokens + u.output_tokens ||
    u.unknown_attempts > u.attempts ||
    (u.source === "not_applicable" && (u.attempts || u.total_tokens)) ||
    (u.source === "unknown" && !u.unknown_attempts)
  )
    throw new Error("Inconsistent usage");
  return u;
}
export function emptyUsage(source: "unknown" | "not_applicable"): Usage {
  return {
    source,
    attempts: source === "unknown" ? 1 : 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    unknown_attempts: source === "unknown" ? 1 : 0,
    currency_cost: "not_computed",
  };
}
export type TerminalStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "budget_exhausted";
export interface Deliverable {
  path: string;
  bytes: number;
  sha256: string;
}
export interface Submission {
  schema_version: 2;
  unit_id: string;
  status: TerminalStatus;
  answer_text: string;
  reason: string;
  /** Filled by the harness from the frozen unit directory; adapters return an empty list. */
  deliverables: Deliverable[];
  /** Deliverable path holding the unified trajectory, when the agent declares that capability. */
  trajectory: string | null;
  native_run: { id: string; directory: string } | null;
  usage: Usage;
  cleanup_error: string | null;
  record_error: boolean;
}
export function validateDeliverables(value: unknown): Deliverable[] {
  if (!Array.isArray(value)) throw new Error("Invalid deliverables");
  let total = 0;
  const result = value.map((v): Deliverable => {
    const d = obj(v);
    keys(d, ["path", "bytes", "sha256"]);
    const bytes = integer(d.bytes, "bytes", 0);
    if (bytes > LIMITS.deliverable) throw new Error("Deliverable too large");
    total += bytes;
    return {
      path: safeRelativePath(str(d.path, "path")),
      bytes,
      sha256: hash(d.sha256),
    };
  });
  if (
    result.length > LIMITS.deliverable_files ||
    total > LIMITS.deliverables ||
    new Set(result.map((d) => d.path)).size !== result.length
  )
    throw new Error("Deliverable limit/duplicate");
  return result;
}
/** v1 inline artifacts map to deliverables stored under the unit's legacy `artifacts/` directory. */
function legacyArtifacts(value: unknown): Deliverable[] {
  if (!Array.isArray(value)) throw new Error("Invalid submission");
  let total = 0;
  const artifacts = value.map((v): Deliverable => {
    const a = obj(v);
    keys(a, ["name", "base64"]);
    const name = id(a.name);
    const base64 = text(a.base64, LIMITS.response);
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64 || bytes.length > LIMITS.artifact)
      throw new Error("Invalid artifact encoding/size");
    total += bytes.length;
    return {
      path: name,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  if (
    total > LIMITS.artifacts ||
    new Set(artifacts.map((a) => a.path)).size !== artifacts.length
  )
    throw new Error("Artifact limit/duplicate");
  return artifacts;
}
/**
 * `frozen: false` is for adapter returns, whose deliverable list is still empty: a declared trajectory
 * is then checked by the harness after freezing instead.
 */
export function validateSubmission(
  value: unknown,
  unitId: string,
  { frozen = true }: { frozen?: boolean } = {},
): Submission {
  bounded(value, LIMITS.response);
  const version = contractVersion(value);
  const x = envelope(
    value,
    [
      "unit_id",
      "status",
      "answer_text",
      "reason",
      version === 1 ? "artifacts" : "deliverables",
      ...(version === 1 ? [] : ["trajectory"]),
      "native_run",
      "usage",
      "cleanup_error",
      "record_error",
    ],
    [1, 2],
  );
  if (x.unit_id !== unitId) throw new Error("Submission identity mismatch");
  if (typeof x.record_error !== "boolean")
    throw new Error("Invalid submission");
  const deliverables =
    version === 1
      ? legacyArtifacts(x.artifacts)
      : validateDeliverables(x.deliverables);
  const trajectory =
    version === 1 || x.trajectory === null
      ? null
      : safeRelativePath(str(x.trajectory, "trajectory"));
  if (!frozen && deliverables.length)
    throw new Error("Adapters must not list deliverables themselves");
  if (
    frozen &&
    trajectory !== null &&
    !deliverables.some((d) => d.path === trajectory)
  )
    throw new Error("Trajectory is not a deliverable");
  let native: Submission["native_run"] = null;
  if (x.native_run !== null) {
    const n = obj(x.native_run);
    keys(n, ["id", "directory"]);
    native = { id: id(n.id), directory: str(n.directory, "directory") };
  }
  return {
    schema_version: 2,
    unit_id: id(x.unit_id),
    status: literal(x.status, [
      "completed",
      "failed",
      "timed_out",
      "cancelled",
      "budget_exhausted",
    ]),
    answer_text: text(x.answer_text),
    reason: text(x.reason),
    deliverables,
    trajectory,
    native_run: native,
    usage: validateUsage(x.usage),
    cleanup_error: x.cleanup_error === null ? null : text(x.cleanup_error),
    record_error: x.record_error,
  };
}
export interface Metric {
  name: string;
  value: number;
  minimum: number;
  maximum: number;
  direction: "higher" | "lower";
}
export interface JudgeSummary {
  /** Role id -> model profile id used for this score. */
  roles: Record<string, string>;
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  unknown_attempts: number;
  elapsed_ms: number;
  /** Model names and fingerprints the service reported; aliases do not pin weights. */
  models: string[];
  fingerprints: string[];
  self_preference_risk: boolean;
}
export function validateJudgeSummary(value: unknown): JudgeSummary {
  const x = obj(value);
  keys(x, [
    "roles",
    "attempts",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "unknown_attempts",
    "elapsed_ms",
    "models",
    "fingerprints",
    "self_preference_risk",
  ]);
  if (typeof x.self_preference_risk !== "boolean")
    throw new Error("Invalid self_preference_risk");
  const summary: JudgeSummary = {
    roles: Object.fromEntries(
      Object.entries(obj(x.roles)).map(([k, v]) => [
        id(k),
        str(v, "judge profile"),
      ]),
    ),
    attempts: integer(x.attempts, "attempts", 0),
    input_tokens: integer(x.input_tokens, "input_tokens", 0),
    output_tokens: integer(x.output_tokens, "output_tokens", 0),
    total_tokens: integer(x.total_tokens, "total_tokens", 0),
    unknown_attempts: integer(x.unknown_attempts, "unknown_attempts", 0),
    elapsed_ms: integer(x.elapsed_ms, "elapsed_ms", 0),
    models: strings(x.models, "models"),
    fingerprints: strings(x.fingerprints, "fingerprints"),
    self_preference_risk: x.self_preference_risk,
  };
  if (
    summary.total_tokens !== summary.input_tokens + summary.output_tokens ||
    summary.unknown_attempts > summary.attempts
  )
    throw new Error("Inconsistent judge summary");
  return summary;
}
export interface Score {
  schema_version: 2;
  unit_id: string;
  protocol: string;
  status: "scored" | "failed";
  metrics: Metric[];
  details: Record<string, unknown>;
  error: string | null;
  /** Null for deterministic protocols; judged scores are model decisions and not reproducible. */
  judge: JudgeSummary | null;
}
export function validateScore(value: unknown, unitId: string): Score {
  const version = contractVersion(value);
  const x = envelope(
    value,
    [
      "unit_id",
      "protocol",
      "status",
      "metrics",
      "details",
      "error",
      ...(version === 2 ? ["judge"] : []),
    ],
    [1, 2],
  );
  if (x.unit_id !== unitId || !Array.isArray(x.metrics))
    throw new Error("Invalid score identity/metrics");
  const metrics = x.metrics.map((v): Metric => {
    const m = obj(v);
    keys(m, ["name", "value", "minimum", "maximum", "direction"]);
    if (
      [m.value, m.minimum, m.maximum].some(
        (n) => typeof n !== "number" || !Number.isFinite(n),
      )
    )
      throw new Error("Invalid metric");
    const value = Number(m.value),
      minimum = Number(m.minimum),
      maximum = Number(m.maximum);
    if (value < minimum || value > maximum || minimum > maximum)
      throw new Error("Metric outside range");
    return {
      name: id(m.name),
      value,
      minimum,
      maximum,
      direction: literal(m.direction, ["higher", "lower"]),
    };
  });
  const status = literal(x.status, ["scored", "failed"]);
  if (
    new Set(metrics.map((m) => m.name)).size !== metrics.length ||
    (status === "failed"
      ? metrics.length !== 0 || typeof x.error !== "string"
      : !metrics.length || x.error !== null)
  )
    throw new Error("Inconsistent score");
  return {
    schema_version: 2,
    unit_id: id(x.unit_id),
    protocol: str(x.protocol, "protocol"),
    status,
    metrics,
    details: obj(x.details),
    error: x.error === null ? null : text(x.error),
    judge:
      version === 1 || x.judge === null ? null : validateJudgeSummary(x.judge),
  };
}
export interface AgentConfig {
  id: string;
  adapter: string;
  options: Record<string, unknown>;
  model: ModelProfile | null;
  require_seed: boolean;
}
export interface Invocation {
  schema_version: 2;
  evaluation_id: string;
  unit_id: string;
  task: PublicTask;
  config: AgentConfig;
  budget: Budget;
  seed: number;
  input_root: string;
  run_root: string;
  /** Unit-owned directory the adapter writes deliverables into before the harness freezes it. */
  deliverables_root: string;
  /** Whether the plan needs a unified trajectory (upstream-compatible scoring). */
  trajectory: boolean;
}
export function validateInvocation(value: unknown): Invocation {
  bounded(value, LIMITS.request);
  const x = envelope(value, [
    "evaluation_id",
    "unit_id",
    "task",
    "config",
    "budget",
    "seed",
    "input_root",
    "run_root",
    "deliverables_root",
    "trajectory",
  ]);
  const c = obj(x.config);
  keys(c, ["id", "adapter", "options", "model", "require_seed"]);
  if (typeof c.require_seed !== "boolean" || typeof x.trajectory !== "boolean")
    throw new Error("Invalid seed/trajectory requirement");
  return {
    schema_version: 2,
    evaluation_id: id(x.evaluation_id),
    unit_id: id(x.unit_id),
    task: validateTask(x.task),
    config: {
      id: id(c.id),
      adapter: id(c.adapter),
      options: obj(c.options),
      model: c.model === null ? null : validateProfile(c.model),
      require_seed: c.require_seed,
    },
    budget: validateBudget(x.budget),
    seed: integer(x.seed, "seed", 0),
    input_root: str(x.input_root, "input_root"),
    run_root: str(x.run_root, "run_root"),
    deliverables_root: str(x.deliverables_root, "deliverables_root"),
    trajectory: x.trajectory,
  };
}
export type JudgeCapability = "text" | "vision";
export interface JudgeRole {
  id: string;
  needs: JudgeCapability[];
}
/** Image parts reference files the scorer may read: frozen deliverables or evaluator-side references. */
export type JudgePart =
  | { type: "text"; text: string }
  | { type: "image"; path: string };
export interface JudgeClient {
  /**
   * Sends one judged item. `parse` turns the reply into a result; a thrown parse error triggers a bounded
   * re-request. Every attempt is recorded and charged whether or not it parses.
   */
  ask<T>(
    role: string,
    parts: JudgePart[],
    label: string,
    parse: (reply: string) => Promise<T> | T,
  ): Promise<T>;
}
export interface GroupSummary {
  name: string;
  metric: string;
  within: "mean";
  across: "mean";
}
export interface ScoringContext {
  deliverables_root: string;
  scoring: Record<string, unknown>;
  judge: JudgeClient | null;
  signal?: AbortSignal;
}
export interface BenchmarkAdapter {
  compatibility?(scores: Score[]): Promise<Record<string, unknown>>;
  id: string;
  version: string;
  protocol: string;
  /** Judge roles this protocol calls; absent or empty for deterministic scoring. */
  judgeRoles?(scoring: Record<string, unknown>): JudgeRole[];
  /** Validates benchmark-specific scoring options (e.g. upstream-compatible mode). */
  scoringOptions?(value: unknown): Record<string, unknown>;
  /** Grouped metrics computed over `catalog().groups`. */
  summaries?: GroupSummary[];
  /** Whether the agent must deliver a unified trajectory under these scoring options. */
  requiresTrajectory?(scoring: Record<string, unknown>): boolean;
  options(value: unknown): Record<string, unknown>;
  catalog(options: Record<string, unknown>): Promise<{
    tasks: PublicTask[];
    source_root: string;
    provenance: Record<string, unknown>;
    groups?: Record<string, string>;
  }>;
  preflight(
    options: Record<string, unknown>,
    tasks: PublicTask[],
  ): Promise<void>;
  score(
    options: Record<string, unknown>,
    task: PublicTask,
    submission: Submission,
    context: ScoringContext,
  ): Promise<Score>;
}
export interface AgentAdapter {
  id: string;
  version: string;
  capabilities: Capabilities;
  options(value: unknown): Record<string, unknown>;
  preflight(config: AgentConfig): Promise<Record<string, unknown>>;
  run(invocation: Invocation, signal?: AbortSignal): Promise<Submission>;
}
