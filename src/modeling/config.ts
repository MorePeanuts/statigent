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
export type ModelingBudget = typeof MODELING_BUDGET;
export function validateModelingTask(value: unknown) {
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
  const budget = { ...MODELING_BUDGET };
  for (const k of Object.keys(raw) as (keyof ModelingBudget)[])
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
  if (
    budget.final_training_attempts >= budget.training_attempts ||
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
export type ModelingTask = ReturnType<typeof validateModelingTask>;
