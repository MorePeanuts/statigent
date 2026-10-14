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

const report = {
  kind: "report",
  instructions: "Write report.md",
  report_file: "report.md",
  image_types: ["png", "jpeg"],
  max_images: 20,
  max_image_bytes: 5242880,
  max_report_bytes: 262144,
};
test("public contract rejects versions, private fields and unsupported outputs", () => {
  expect(validateTask(task)).toEqual(task);
  for (const bad of [
    { ...task, schema_version: 4 },
    { ...task, labels: [] },
    { ...task, output: { kind: "prediction", instructions: "x" } },
    { ...task, goal: "a".repeat(LIMITS.request) },
  ])
    expect(() => validateTask(bad)).toThrow();
});
test("v2 adds report outputs and empty inputs; v1 tasks stay readable but unchanged in meaning", () => {
  expect(validateTask({ ...task, output: report }).output).toEqual(
    report as never,
  );
  for (const field of Object.keys(report).filter((k) => k !== "kind")) {
    const { [field]: _removed, ...partial } = report as Record<string, unknown>;
    expect(() => validateTask({ ...task, output: partial })).toThrow();
  }
  for (const output of [
    { ...report, extra: true },
    { ...report, report_file: "../report.md" },
    { ...report, report_file: "report.txt" },
    { ...report, image_types: ["gif"] },
    { ...report, max_image_bytes: LIMITS.deliverable + 1 },
  ])
    expect(() => validateTask({ ...task, output })).toThrow();
  expect(validateTask({ ...task, inputs: [] }).inputs).toEqual([]);
  const v1 = { ...task, schema_version: 1 };
  expect(validateTask(v1)).toEqual(task);
  expect(() => validateTask({ ...v1, inputs: [] })).toThrow("Inputs");
  expect(() => validateTask({ ...v1, output: report })).toThrow();
});
test("v1 submissions and scores normalize to v2 without changing their content", () => {
  const { deliverables: _d, trajectory: _t, ...rest } = submission();
  const legacy = {
    ...rest,
    schema_version: 1,
    artifacts: [{ name: "result.txt", base64: "Mw==" }],
  };
  const s = validateSubmission(legacy, "unit-000001");
  expect(s.schema_version).toBe(2);
  expect(s.deliverables).toEqual([
    {
      path: "result.txt",
      bytes: 1,
      sha256:
        "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
    },
  ]);
  expect(() =>
    validateSubmission({ ...legacy, deliverables: [] }, "unit-000001"),
  ).toThrow();
  expect(() =>
    validateSubmission(
      { ...submission(), trajectory: "missing.txt" },
      "unit-000001",
    ),
  ).toThrow("Trajectory");
  for (const path of ["../x", "/x", "a//b"])
    expect(() =>
      validateSubmission(
        {
          ...submission(),
          deliverables: [{ path, bytes: 1, sha256: "a".repeat(64) }],
        },
        "unit-000001",
      ),
    ).toThrow();
  const score = {
    schema_version: 1,
    unit_id: "x",
    protocol: "p",
    status: "scored",
    metrics: [
      { name: "m", value: 1, minimum: 0, maximum: 1, direction: "higher" },
    ],
    details: {},
    error: null,
  };
  expect(validateScore(score, "x").judge).toBeNull();
  expect(() => validateScore({ ...score, judge: null }, "x")).toThrow();
  expect(
    validateScore({ ...score, schema_version: 2, judge: null }, "x").judge,
  ).toBeNull();
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
test("report tasks are rejected for text-only agents before any execution", async () => {
  let calls = 0;
  const registry = fixtureRegistry("/tmp/fixture", async (i) => {
    calls++;
    return submission(i.unit_id);
  });
  const benchmark = registry.getBenchmark("synthetic");
  const catalog = benchmark.catalog;
  benchmark.catalog = async (o) => {
    const c = await catalog(o);
    return {
      ...c,
      tasks: c.tasks.map((t) => ({ ...t, output: report as never })),
    };
  };
  await expect(buildPlan(config(), registry)).rejects.toThrow(
    "Unsupported task output: report",
  );
  registry.getAgent("fixture").capabilities.outputs = ["text", "report"];
  expect((await buildPlan(config(), registry)).units).toHaveLength(2);
  expect(calls).toBe(0);
});
test("documented v2 report task example satisfies the contract", async () => {
  const doc = await Bun.file("docs/evaluation.md").text();
  const section = doc.slice(doc.indexOf("## 契约版本"));
  const block = /```json\n([\s\S]*?)```/.exec(section)?.[1];
  if (!block) throw new Error("Missing documented example");
  const parsed = validateTask(JSON.parse(block));
  expect(parsed.output.kind).toBe("report");
  expect(() =>
    validateTask({ ...JSON.parse(block), schema_version: 1 }),
  ).toThrow();
});
