import { expect, test } from "bun:test";
import {
  MODELING_METHODS,
  validateFrozenModelingTask,
  validateModelingTask,
} from "../../src/modeling/config";

const legacy = {
  goal: "predict",
  dataset_root: "runs/data",
  image: "test",
  model_profile: "test",
};
const current = {
  ...legacy,
  schema_version: 2,
  method: "collaborative",
  confirmation: { mode: "none" },
  resource_version: "smoke-v1",
};

test("new starts require explicit semantics; frozen historical configurations remain unchanged", () => {
  for (const value of [
    legacy,
    { ...current, schema_version: undefined },
    { ...current, method: undefined },
  ])
    expect(() => validateModelingTask(value)).toThrow("Migrate modeling task");
  const old = validateFrozenModelingTask(legacy);
  expect(validateFrozenModelingTask(old)).toEqual(old);
  expect("method" in old).toBe(false);
  expect(() => validateFrozenModelingTask(current)).toThrow();
  for (const method of MODELING_METHODS) {
    const task = validateModelingTask({ ...current, method });
    expect(validateModelingTask(task)).toEqual(task);
    expect(task.budget).toEqual(old.budget);
  }
});

test("invalid modes, resource versions and infeasible confirmation fail before execution", () => {
  for (const patch of [
    { method: "unknown" },
    { confirmation: undefined },
    { confirmation: { mode: "unknown" } },
    { resource_version: "" },
    { method: "initial_eda", budget: { eda_calls: 0 } },
    { confirmation: { mode: "terminal_repeated_holdout" } },
    { confirmation: { mode: "none", hidden: true } },
  ])
    expect(() => validateModelingTask({ ...current, ...patch })).toThrow();
  const confirmation = { mode: "terminal_repeated_holdout" };
  const budget = {
    training_attempts: 8,
    final_reserve_ms: 750000,
    task_timeout_ms: 1200000,
  };
  expect(
    validateModelingTask({ ...current, confirmation, budget }).confirmation
      .mode,
  ).toBe("terminal_repeated_holdout");
  for (const patch of [{ training_attempts: 5 }, { final_reserve_ms: 749999 }])
    expect(() =>
      validateModelingTask({
        ...current,
        confirmation,
        budget: { ...budget, ...patch },
      }),
    ).toThrow("reserve");
});

test("repository run examples explicitly migrate without enlarging smoke budgets", async () => {
  for (const name of ["synthetic", "dsbench-s3e9", "binary", "multiclass"]) {
    const input = await Bun.file(`configs/modeling/${name}.json`).json();
    const task = validateModelingTask(input);
    expect(task.method).toBe("adaptive_eda");
    expect(task.confirmation.mode).toBe("none");
    expect(task.resource_version).toBe("smoke-v1");
    expect(task.budget.training_attempts).toBe(4);
    expect(task.budget.eda_calls).toBe(1);
    expect(task.budget.total_tokens).toBe(600000);
    expect(task.budget.task_timeout_ms).toBe(900000);
  }
});
