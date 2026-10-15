import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { modelingTaskFromPrepared } from "../../src/evaluation/benchmarks/modeling/publication";
import { validateInvocation } from "../../src/evaluation/contracts";
import { publishTaskInputs } from "../../src/evaluation/files";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { profile } from "./agent";

export async function preparedModelingTask(
  root: string,
  preparationCode?: string,
) {
  await command(
    [
      "uv",
      "run",
      "--offline",
      "--frozen",
      "--no-sync",
      "python",
      "-c",
      preparationCode ??
        "from pathlib import Path; import sys; from test_modeling_dataset_v3 import prepare; prepare(Path(sys.argv[1]))",
      join(root, "data"),
    ],
    {
      timeout_ms: 10000,
      env: {
        ...commandEnvironment(),
        PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
      },
    },
  );
  return modelingTaskFromPrepared(
    root,
    "data",
    "synthetic-modeling",
    "Predict all targets from allowed training data",
  );
}

export const modelingSettings = {
  image: "statigent-runtime:modeling-benchmarks",
  method: "no_eda",
  confirmation: { mode: "none" },
  resource_version: "adapter-test-v1",
  budget: {
    fit_timeout_ms: 30000,
    predict_timeout_ms: 30000,
    final_reserve_ms: 100000,
  },
};

export async function modelingInvocation(
  root: string,
  preparationCode?: string,
) {
  const task = await preparedModelingTask(root, preparationCode),
    inputRoot = join(root, "input");
  const published = await publishTaskInputs(root, task, inputRoot);
  await mkdir(join(root, "native"));
  await mkdir(join(root, "deliverables"));
  return validateInvocation({
    schema_version: 3,
    evaluation_id: "adapter-test",
    unit_id: "unit-000001",
    task,
    config: {
      id: "native",
      adapter: "statigent-modeling",
      options: modelingSettings,
      model: profile,
      require_seed: true,
    },
    budget: { timeout_ms: 400000, model_attempts: 40, total_tokens: 600000 },
    seed: 17,
    input_root: inputRoot,
    phase_roots: published.phase_roots,
    run_root: join(root, "native"),
    deliverables_root: join(root, "deliverables"),
    trajectory: false,
  });
}
