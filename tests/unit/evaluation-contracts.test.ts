import { expect, test } from "bun:test";
import example from "../fixtures/evaluation-config.json";

test("documented synthetic configuration parses", () => {
  expect(validateConfig(example, fixtureRegistry())).toEqual(
    validateConfig(config(), fixtureRegistry()),
  );
});

import {
  LIMITS,
  validateScore,
  validateSubmission,
  validateTask,
  validateUsage,
} from "../../src/evaluation/contracts";
import { buildPlan, validateConfig } from "../../src/evaluation/plan";
import {
  config,
  fixtureRegistry,
  submission,
  task,
} from "../helpers/evaluation";

test("public contract rejects versions, private fields and unsupported outputs", () => {
  expect(validateTask(task)).toEqual(task);
  for (const bad of [
    { ...task, schema_version: 2 },
    { ...task, labels: [] },
    { ...task, output: { kind: "prediction", instructions: "x" } },
    { ...task, goal: "a".repeat(LIMITS.request) },
  ])
    expect(() => validateTask(bad)).toThrow();
});
test("submission checks identity, paths, encoding and usage instead of inferring success", () => {
  expect(validateSubmission(submission(), "unit-000001")).toEqual(submission());
  expect(() => validateSubmission(submission(), "other")).toThrow();
  for (const name of ["../secret", "/secret", "a/b"])
    expect(() =>
      validateSubmission(
        { ...submission(), artifacts: [{ name, base64: "YQ==" }] },
        "unit-000001",
      ),
    ).toThrow();
  expect(() =>
    validateSubmission(
      { ...submission(), artifacts: [{ name: "file", base64: "!" }] },
      "unit-000001",
    ),
  ).toThrow();
  expect(() => validateUsage({ ...submission().usage, attempts: 1 })).toThrow();
  expect(() =>
    validateScore(
      {
        schema_version: 1,
        unit_id: "x",
        protocol: "p",
        status: "failed",
        metrics: [],
        details: {},
        error: null,
      },
      "x",
    ),
  ).toThrow();
});
test("config rejects unsupported capabilities and duplicate identities", () => {
  const c = config(),
    registry = fixtureRegistry();
  expect(validateConfig(c, registry).agents[0]?.model).toBeNull();
  expect(() =>
    validateConfig({ ...c, agents: [...c.agents, ...c.agents] }, registry),
  ).toThrow();
  expect(() =>
    validateConfig(
      { ...c, benchmark: { ...c.benchmark, adapter: "unknown" } },
      registry,
    ),
  ).toThrow();
  expect(() =>
    validateConfig(
      { ...c, agents: [{ ...c.agents[0], options: { role: "planner" } }] },
      registry,
    ),
  ).toThrow();
});
test("plan expands 2 x 2 x 3 without executing either agent", async () => {
  let calls = 0;
  const registry = fixtureRegistry("/tmp/fixture", async (i) => {
    calls++;
    return submission(i.unit_id);
  });
  const c = config();
  const v = {
    ...c,
    agents: [...c.agents, { ...c.agents[0], id: "b" }],
    repetitions: 3,
  };
  const plan = await buildPlan(v, registry);
  expect(plan.units).toHaveLength(12);
  expect(new Set(plan.units.map((u) => u.id)).size).toBe(12);
  expect((await buildPlan(v, registry)).sha256).toBe(plan.sha256);
  expect(calls).toBe(0);
  await expect(
    buildPlan(
      { ...v, benchmark: { ...v.benchmark, version: "bad" } },
      registry,
    ),
  ).rejects.toThrow();
  await expect(
    buildPlan(
      { ...v, benchmark: { ...v.benchmark, task_ids: ["missing"] } },
      registry,
    ),
  ).rejects.toThrow();
});
