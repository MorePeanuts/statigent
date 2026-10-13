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
  const execution = validateConfig({
    run_id: "preflight",
    staging_root: "preflight",
    image: str(x.image, "image"),
    input_root: resolve(str(x.dataset_root, "dataset_root")),
    inputs: [],
    seed: 0,
    limits: {
      ...DEFAULT_LIMITS,
      memory_bytes: 2 * 1024 ** 3,
      workspace_bytes: 256 * 1024 ** 2,
      tmp_bytes: 128 * 1024 ** 2,
      max_artifact_bytes: 16 * 1024 ** 2,
      max_artifacts_bytes: 64 * 1024 ** 2,
      ...obj(x.limits ?? {}),
      task_timeout_ms: budget.task_timeout_ms,
    },
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
