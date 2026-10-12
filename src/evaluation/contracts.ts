import { type ModelProfile, validateProfile } from "../models/config";
import { integer, keys, obj, str, strings } from "../models/validation";
import { safeRelativePath } from "../records/store";

export const VERSION = 1;
export const LIMITS = {
  request: 262144,
  response: 8388608,
  stderr: 1048576,
  artifact: 1048576,
  artifacts: 4194304,
  record: 16777216,
  events: 16777216,
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
): Record<string, unknown> {
  bounded(value, LIMITS.record);
  const x = obj(value);
  keys(x, ["schema_version", ...allowed]);
  if (x.schema_version !== VERSION)
    throw new Error("Unsupported schema_version");
  return x;
}
export interface InputFile {
  path: string;
  sha256: string;
  bytes: number;
}
export interface PublicTask {
  schema_version: 1;
  id: string;
  version: string;
  goal: string;
  constraints: string[];
  inputs: InputFile[];
  output: { kind: "text"; instructions: string };
}
export function validateTask(value: unknown): PublicTask {
  bounded(value, LIMITS.request);
  const x = envelope(value, [
    "id",
    "version",
    "goal",
    "constraints",
    "inputs",
    "output",
  ]);
  if (!Array.isArray(x.inputs) || x.inputs.length === 0)
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
  const o = obj(x.output);
  keys(o, ["kind", "instructions"]);
  return {
    schema_version: 1,
    id: id(x.id),
    version: str(x.version, "version"),
    goal: str(x.goal, "goal"),
    constraints: strings(x.constraints, "constraints"),
    inputs,
    output: {
      kind: literal(o.kind, ["text"]),
      instructions: str(o.instructions, "instructions"),
    },
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
  schema_version: 1;
  output: "text";
  model: "configurable" | "none";
  seed: "execution" | "unsupported";
  isolation: "docker";
  model_budget: boolean;
  usage: "measured" | "self_reported" | "not_applicable";
}
export function validateCapabilities(value: unknown): Capabilities {
  const x = envelope(value, [
    "output",
    "model",
    "seed",
    "isolation",
    "model_budget",
    "usage",
  ]);
  if (typeof x.model_budget !== "boolean")
    throw new Error("Invalid model_budget");
  const result: Capabilities = {
    schema_version: 1,
    output: literal(x.output, ["text"]),
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
export interface Submission {
  schema_version: 1;
  unit_id: string;
  status: TerminalStatus;
  answer_text: string;
  reason: string;
  artifacts: { name: string; base64: string }[];
  native_run: { id: string; directory: string } | null;
  usage: Usage;
  cleanup_error: string | null;
  record_error: boolean;
}
export function validateSubmission(value: unknown, unitId: string): Submission {
  bounded(value, LIMITS.response);
  const x = envelope(value, [
    "unit_id",
    "status",
    "answer_text",
    "reason",
    "artifacts",
    "native_run",
    "usage",
    "cleanup_error",
    "record_error",
  ]);
  if (x.unit_id !== unitId) throw new Error("Submission identity mismatch");
  if (!Array.isArray(x.artifacts) || typeof x.record_error !== "boolean")
    throw new Error("Invalid submission");
  let total = 0;
  const artifacts = x.artifacts.map((v) => {
    const a = obj(v);
    keys(a, ["name", "base64"]);
    const name = id(a.name);
    const base64 = text(a.base64, LIMITS.response);
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64 || bytes.length > LIMITS.artifact)
      throw new Error("Invalid artifact encoding/size");
    total += bytes.length;
    return { name, base64 };
  });
  if (
    total > LIMITS.artifacts ||
    new Set(artifacts.map((a) => a.name)).size !== artifacts.length
  )
    throw new Error("Artifact limit/duplicate");
  let native: Submission["native_run"] = null;
  if (x.native_run !== null) {
    const n = obj(x.native_run);
    keys(n, ["id", "directory"]);
    native = { id: id(n.id), directory: str(n.directory, "directory") };
  }
  return {
    schema_version: 1,
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
    artifacts,
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
export interface Score {
  schema_version: 1;
  unit_id: string;
  protocol: string;
  status: "scored" | "failed";
  metrics: Metric[];
  details: Record<string, unknown>;
  error: string | null;
}
export function validateScore(value: unknown, unitId: string): Score {
  const x = envelope(value, [
    "unit_id",
    "protocol",
    "status",
    "metrics",
    "details",
    "error",
  ]);
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
    schema_version: 1,
    unit_id: id(x.unit_id),
    protocol: str(x.protocol, "protocol"),
    status,
    metrics,
    details: obj(x.details),
    error: x.error === null ? null : text(x.error),
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
  schema_version: 1;
  evaluation_id: string;
  unit_id: string;
  task: PublicTask;
  config: AgentConfig;
  budget: Budget;
  seed: number;
  input_root: string;
  run_root: string;
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
  ]);
  const c = obj(x.config);
  keys(c, ["id", "adapter", "options", "model", "require_seed"]);
  if (typeof c.require_seed !== "boolean")
    throw new Error("Invalid seed requirement");
  return {
    schema_version: 1,
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
  };
}
export interface BenchmarkAdapter {
  compatibility?(scores: Score[]): Promise<Record<string, unknown>>;
  id: string;
  version: string;
  protocol: string;
  options(value: unknown): Record<string, unknown>;
  catalog(options: Record<string, unknown>): Promise<{
    tasks: PublicTask[];
    source_root: string;
    provenance: Record<string, unknown>;
  }>;
  preflight(
    options: Record<string, unknown>,
    tasks: PublicTask[],
  ): Promise<void>;
  score(
    options: Record<string, unknown>,
    task: PublicTask,
    submission: Submission,
    signal?: AbortSignal,
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
