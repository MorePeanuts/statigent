import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsage } from "../../src/evaluation/contracts";
import {
  modelingSmoke,
  parseModelingSmoke,
} from "../../src/evaluation/modeling-smoke";
import { Registry } from "../../src/evaluation/plan";
import { obj } from "../../src/models/validation";
import { profile } from "../helpers/agent";
import { config, fixtureRegistry, submission } from "../helpers/evaluation";
import { preparedModelingTask } from "../helpers/evaluation-modeling";

let root: string,
  scope: string,
  registry: Registry,
  calls = 0,
  preflights = 0;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "modeling-smoke-")));
  const task = await preparedModelingTask(root),
    base = fixtureRegistry(root);
  registry = new Registry()
    .benchmark({
      ...base.getBenchmark("synthetic"),
      catalog: async () => ({
        tasks: [task],
        source_root: root,
        provenance: { version: "v1" },
      }),
    })
    .agent({
      ...base.getAgent("fixture"),
      id: "statigent-modeling",
      capabilities: {
        schema_version: 3,
        outputs: ["predictions"],
        phase_isolation: true,
        trajectory: "none",
        model: "configurable",
        seed: "execution",
        isolation: "docker",
        model_budget: true,
        usage: "measured",
      },
      options: obj,
      preflight: async () => {
        preflights++;
        return {};
      },
      run: async (i) => {
        calls++;
        return {
          ...submission(i.unit_id),
          schema_version: 3,
          status: "failed",
          reason: "controlled_first_failure",
          usage: { ...emptyUsage("not_applicable"), source: "measured" },
        };
      },
    });
  const file = join(root, "config.json"),
    models = join(root, "models.json");
  await Bun.write(models, JSON.stringify([profile]));
  await Bun.write(
    file,
    JSON.stringify({
      ...config(),
      schema_version: 3,
      cache_policy: "disabled",
      seed: 17,
      benchmark: {
        adapter: "synthetic",
        version: "v1",
        options: {},
        task_ids: [task.id],
      },
      agents: [
        {
          id: "no_eda",
          adapter: "statigent-modeling",
          options: { method: "no_eda", resource_version: "test-v1" },
          model_profile: profile.id,
          require_seed: true,
        },
      ],
      task_budget: { timeout_ms: 10000, model_attempts: 2, total_tokens: 1000 },
      batch_budget: {
        timeout_ms: 10000,
        model_attempts: 2,
        total_tokens: 1000,
      },
    }),
  );
  scope = join(root, "scope.json");
  await Bun.write(
    scope,
    JSON.stringify({
      schema_version: 1,
      name: "test-smoke",
      config_files: [file],
      models_file: models,
      allowed_tasks: [`synthetic/${task.id}`],
      allowed_methods: ["no_eda"],
      model_profile: profile.id,
      seed: 17,
      resource_version: "test-v1",
    }),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("default/help and read-only preflight cannot dispatch even with a credential present", async () => {
  const previous = process.env[profile.api_key_env];
  process.env[profile.api_key_env] = "synthetic-present-key";
  try {
    const before = await readdir(root);
    expect(await modelingSmoke([], registry)).toHaveProperty("model_calls", 0);
    expect(
      await modelingSmoke(["--preflight", "--scope", scope], registry),
    ).toMatchObject({
      status: "passed",
      units: 1,
      model_calls: 0,
      fits: 0,
      automatic_rerun: false,
    });
    expect(calls).toBe(0);
    expect(preflights).toBe(0);
    expect(await readdir(root)).toEqual(before);
  } finally {
    if (previous === undefined) delete process.env[profile.api_key_env];
    else process.env[profile.api_key_env] = previous;
  }
});

test("live execution requires explicit authorization, rejects scope drift and retains the first failure without retry", async () => {
  for (const args of [
    ["--run", "--scope", scope],
    ["--scope", scope],
    ["--preflight", "--allow-model-calls", "--scope", scope],
  ])
    expect(() => parseModelingSmoke(args)).toThrow();
  const drift = join(root, "drift.json");
  await Bun.write(
    drift,
    JSON.stringify({ ...(await Bun.file(scope).json()), seed: 99 }),
  );
  await expect(
    modelingSmoke(["--preflight", "--scope", drift], registry),
  ).rejects.toThrow("mismatch");
  const out = join(root, "attempt");
  const result = await modelingSmoke(
    ["--run", "--allow-model-calls", "--scope", scope, "--out", out],
    registry,
  );
  expect(result).toHaveProperty("status", "incomplete");
  expect(calls).toBe(1);
  const stored = await Bun.file(join(out, "result.json")).json();
  expect(stored.automatic_rerun).toBe(false);
  expect(stored.results[0].units[0]).toMatchObject({
    execution_status: "failed",
    reason: "controlled_first_failure",
  });
  expect(stored.results[0].reproductions[0]).toMatchObject({
    status: "not_run",
    reason: "no_complete_delivery",
  });
  await expect(
    modelingSmoke(
      ["--run", "--allow-model-calls", "--scope", scope, "--out", out],
      registry,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
