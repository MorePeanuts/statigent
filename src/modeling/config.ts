import { resolve } from "node:path";
import { DEFAULT_BUDGET } from "../agent/config";
import { DEFAULT_LIMITS, validateConfig } from "../execution/protocol";
import { integer, keys, obj, str } from "../models/validation";
export const MODELING_BUDGET = {
  ...DEFAULT_BUDGET,
  model_attempts: 40,
  total_tokens: 600000,
  task_timeout_ms: 900000,
  training_attempts: 4,
  final_training_attempts: 1,
  final_reserve_ms: 180000,
  fit_timeout_ms: 120000,
  predict_timeout_ms: 30000,
  eda_calls: 1,
  eda_executions: 10,
  eda_model_attempts: 20,
  eda_tokens: 400000,
  eda_timeout_ms: 300000,
  max_candidates: 16,
};
export type ModelingBudget = Omit<
  typeof MODELING_BUDGET,
  "training_attempts"
> & { training_attempts: number | null };
export const MODELING_METHODS = [
  "no_eda",
  "initial_eda",
  "adaptive_eda",
  "collaborative",
] as const;
export type ModelingMethod = (typeof MODELING_METHODS)[number];

// Historical delivery reads retain their original configuration semantics.
// This parser is never an alternate entry point for starting a new search.
export function validateFrozenModelingTask(
  value: unknown,
  allowUnbounded = false,
) {
  const x = obj(value);
  keys(x, [
    "goal",
    "dataset_root",
    "model_profile",
    "eda_profile",
    "image",
    "budget",
    "limits",
  ]);
  const raw = obj(x.budget ?? {});
  keys(raw, Object.keys(MODELING_BUDGET));
  const budget: ModelingBudget = { ...MODELING_BUDGET };
  for (const k of Object.keys(raw) as (keyof ModelingBudget)[]) {
    if (k === "training_attempts" && raw[k] === null && allowUnbounded) {
      budget.training_attempts = null;
      continue;
    }
    budget[k] = integer(
      raw[k],
      k,
      [
        "rate_retries",
        "code_repairs",
        "action_corrections",
        "eda_calls",
        "eda_executions",
      ].includes(k)
        ? 0
        : 1,
    );
  }
  if (
    (budget.training_attempts !== null &&
      budget.final_training_attempts >= budget.training_attempts) ||
    budget.final_reserve_ms >= budget.task_timeout_ms ||
    budget.final_reserve_ms < budget.fit_timeout_ms + budget.predict_timeout_ms
  )
    throw new Error("Invalid finalization reserve");
  const limits = {
    ...DEFAULT_LIMITS,
    // Tree ensembles can exceed 150 MiB even on the 4,325-row development task.
    // Leave room for fitting plus tmpfs and the current base64/JSON transport copies.
    memory_bytes: 4 * 1024 ** 3,
    workspace_bytes: 512 * 1024 ** 2,
    tmp_bytes: 128 * 1024 ** 2,
    // Closing collects another snapshot; a ~174 MiB frame takes over 3 seconds.
    interrupt_grace_ms: 15000,
    max_artifact_bytes: 256 * 1024 ** 2,
    // Execution and close snapshots both count, including per-file metadata.
    max_artifacts_bytes: 1024 ** 3,
    ...obj(x.limits ?? {}),
    task_timeout_ms: budget.task_timeout_ms,
  };
  // Artifacts use one base64 JSON frame. Derive the frame allowance unless the
  // caller explicitly froze it (including older runs used for reproduction).
  const artifactBytes = integer(
    limits.max_artifact_bytes,
    "max_artifact_bytes",
  );
  if (obj(x.limits ?? {}).max_frame_bytes === undefined)
    limits.max_frame_bytes = Math.max(
      DEFAULT_LIMITS.max_frame_bytes,
      Math.ceil(artifactBytes / 3) * 4 + 64 * 1024,
    );
  const execution = validateConfig({
    run_id: "preflight",
    staging_root: "preflight",
    image: str(x.image, "image"),
    input_root: resolve(str(x.dataset_root, "dataset_root")),
    inputs: [],
    seed: 0,
    limits,
  });
  return {
    goal: str(x.goal, "goal"),
    dataset_root: execution.input_root,
    model_profile: str(x.model_profile, "model profile"),
    eda_profile: str(x.eda_profile ?? x.model_profile, "EDA profile"),
    image: execution.image,
    limits: execution.limits,
    budget,
  };
}
export function validateRecordedModelingTask(value: unknown) {
  const x = obj(value);
  if (x.schema_version === 4) return validateBenchmarkModelingTask(x);
  if (
    (x.schema_version !== 2 && x.schema_version !== 3) ||
    x.method === undefined
  )
    throw new Error(
      "Migrate modeling task: declare schema_version: 2, method and confirmation.mode explicitly",
    );
  if (!MODELING_METHODS.some((method) => method === x.method))
    throw new Error("Invalid modeling method");
  const confirmation = obj(x.confirmation);
  keys(confirmation, ["mode"]);
  const mode = confirmation.mode;
  if (mode !== "none" && mode !== "terminal_repeated_holdout")
    throw new Error("Invalid confirmation mode");
  const {
    schema_version: _version,
    method,
    confirmation: _confirmation,
    resource_version,
    ...base
  } = x;
  const task = validateFrozenModelingTask(base, x.schema_version === 3);
  if (
    method === "initial_eda" &&
    (!task.budget.eda_calls || !task.budget.eda_executions)
  )
    throw new Error("initial_eda requires a positive EDA allowance");
  const confirmationAttempts = mode === "none" ? 0 : 4;
  if (
    (task.budget.training_attempts !== null &&
      task.budget.training_attempts <=
        confirmationAttempts + task.budget.final_training_attempts) ||
    task.budget.final_reserve_ms <
      (confirmationAttempts + task.budget.final_training_attempts) *
        (task.budget.fit_timeout_ms + task.budget.predict_timeout_ms)
  )
    throw new Error("Insufficient confirmation/finalization reserve");
  return {
    ...task,
    schema_version: x.schema_version as 2 | 3,
    method: method as ModelingMethod,
    confirmation: { mode: mode as "none" | "terminal_repeated_holdout" },
    resource_version: str(resource_version, "resource_version"),
  };
}
export function validateBenchmarkModelingTask(value: unknown): ReturnType<
  typeof validateFrozenModelingTask
> & {
  schema_version: 4;
  method: ModelingMethod;
  confirmation: { mode: "none" | "terminal_repeated_holdout" };
  resource_version: string;
  delivery_mode: "fit_only" | "fit_predict";
} {
  const x = obj(value);
  if (
    x.schema_version !== 4 ||
    (x.delivery_mode !== "fit_only" && x.delivery_mode !== "fit_predict")
  )
    throw new Error(
      "Modeling task v4 requires explicit delivery_mode fit_only/fit_predict",
    );
  const { delivery_mode, ...rest } = x;
  const task = validateRecordedModelingTask({ ...rest, schema_version: 3 });
  return { ...task, schema_version: 4, delivery_mode };
}
export function validateModelingTask(value: unknown) {
  if (obj(value).schema_version === 4)
    return validateBenchmarkModelingTask(value);
  if (obj(value).schema_version !== 3)
    throw new Error(
      "Migrate modeling task: declare schema_version: 3, method and confirmation.mode explicitly",
    );
  return { ...validateRecordedModelingTask(value), schema_version: 3 as const };
}
export type ModelingExecutionTask = ReturnType<
  typeof validateFrozenModelingTask
>;
export type ModelingTask = ReturnType<typeof validateModelingTask>;
