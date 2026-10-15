import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselineOptionsSchema,
  methodManifest,
} from "../../src/baselines/catalog";
import {
  baselineSmoke,
  parseBaselineSmoke,
  smokeScopeSchema,
} from "../../src/baselines/smoke";
import { config, fixtureRegistry } from "../helpers/evaluation";

test("baseline smoke is explicit, defaults to help, rejects ambiguous or paid preflight", async () => {
  expect(await baselineSmoke([])).toMatchObject({ model_calls: 0 });
  for (const args of [
    ["--run"],
    ["--scope", "x"],
    ["--run", "--scope", "x"],
    ["--preflight", "--scope", "x", "--allow-model-calls"],
    ["--preflight", "--run", "--scope", "x"],
    ["--preflight", "--scope", "x", "--out", "y"],
    ["--preflight", "--preflight", "--scope", "x"],
  ])
    expect(() => parseBaselineSmoke(args)).toThrow();
  await expect(
    baselineSmoke([
      "--run",
      "--scope",
      "configs/evaluations/baselines/scope-modeling-agents.json",
      "--out",
      "unused",
    ]),
  ).rejects.toThrow("--allow-model-calls");
  await expect(
    baselineSmoke([
      "--run",
      "--scope",
      "configs/evaluations/baselines/scope-modeling-automl.json",
      "--out",
      "unused",
    ]),
  ).rejects.toThrow("--allow-training");
});

test("scope preflight rejects missing units and unbounded budgets before dispatch", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "baseline-scope-")));
  try {
    let dispatched = 0;
    const registry = fixtureRegistry(root, async () => {
      dispatched++;
      throw new Error("not authorized by preflight");
    });
    const fixture = registry.getAgent("fixture");
    registry.agent({
      ...fixture,
      id: "autogluon",
      version: methodManifest("autogluon").version,
      options: (v) => baselineOptionsSchema.parse(v),
    });
    const raw = {
      ...config(),
      agents: [
        {
          id: "automl",
          adapter: "autogluon",
          options: {
            schema_version: 1,
            method: "autogluon",
            image: "fixture:no-container",
          },
          require_seed: true,
        },
      ],
      task_budget: { timeout_ms: 1000, model_attempts: 1, total_tokens: 100 },
      batch_budget: { timeout_ms: 10000, model_attempts: 2, total_tokens: 200 },
    };
    const configPath = join(root, "config.json"),
      scopePath = join(root, "scope.json");
    const scope = {
      schema_version: 1,
      name: "fixture",
      configs: [configPath],
      models: join(root, "models.json"),
      methods: ["autogluon"],
      tasks: ["synthetic/one", "synthetic/two"],
    };
    await writeFile(scope.models, "[]");
    await writeFile(configPath, JSON.stringify(raw));
    await writeFile(scopePath, JSON.stringify(scope));
    const args = ["--preflight", "--scope", scopePath];
    expect(await baselineSmoke(args, registry)).toMatchObject({
      status: "preflight",
      model_calls: 0,
    });
    for (const changes of [
      { methods: ["autogluon", "react"] },
      { tasks: [...scope.tasks, "synthetic/missing"] },
    ]) {
      await writeFile(scopePath, JSON.stringify({ ...scope, ...changes }));
      await expect(baselineSmoke(args, registry)).rejects.toThrow(
        "Missing method/task",
      );
    }
    await writeFile(scopePath, JSON.stringify(scope));
    for (const key of ["task_budget", "batch_budget"] as const) {
      await writeFile(
        configPath,
        JSON.stringify({ ...raw, [key]: { ...raw[key], total_tokens: null } }),
      );
      await expect(baselineSmoke(args, registry)).rejects.toThrow(
        "Finite explicit budgets",
      );
    }
    expect(dispatched).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("fixed scopes retain 9 analysis, 30 Agent modeling and 10 AutoML units", async () => {
  for (const [name, count] of [
    ["analysis", 9],
    ["modeling-agents", 30],
    ["modeling-automl", 10],
  ] as const) {
    const scope = smokeScopeSchema.parse(
      await Bun.file(`configs/evaluations/baselines/scope-${name}.json`).json(),
    );
    expect(scope.tasks.length * scope.methods.length).toBe(count);
    for (const field of ["tasks", "methods"] as const) {
      expect(() => smokeScopeSchema.parse({ ...scope, [field]: [] })).toThrow();
      expect(() =>
        smokeScopeSchema.parse({
          ...scope,
          [field]: [scope[field][0], scope[field][0]],
        }),
      ).toThrow();
    }
  }
});
