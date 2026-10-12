import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentAdapter, emptyUsage } from "../../src/evaluation/contracts";
import { buildPlan } from "../../src/evaluation/plan";
import { inspect } from "../../src/evaluation/records";
import { runEvaluation } from "../../src/evaluation/run";
import { profile } from "../helpers/agent";
import { config, fixtureRegistry, submission } from "../helpers/evaluation";

const roots: string[] = [];
async function setup(run?: AgentAdapter["run"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "batch-test-")));
  roots.push(root);
  await writeFile(join(root, "data.csv"), "value\n1\n2\n");
  return { root, registry: fixtureRegistry(root, run) };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("two independently registered benchmarks and agents use one serial runner", async () => {
  let active = 0,
    max = 0;
  const identities = new Set<string>();
  let calls = 0;
  const { root, registry } = await setup(async (i) => {
    active++;
    max = Math.max(max, active);
    identities.add(i.input_root);
    calls++;
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return {
      ...submission(i.unit_id),
      status: calls === 1 ? "failed" : "completed",
    };
  });
  registry.benchmark({ ...registry.getBenchmark("synthetic"), id: "second" });
  registry.agent({ ...registry.getAgent("fixture"), id: "other" });
  for (const benchmark of ["synthetic", "second"]) {
    const c = config();
    const plan = await buildPlan(
      {
        ...c,
        benchmark: { ...c.benchmark, adapter: benchmark },
        agents: [...c.agents, { ...c.agents[0], id: "b", adapter: "other" }],
        repetitions: 2,
      },
      registry,
    );
    const result = await runEvaluation(plan, registry, join(root, "runs"), {
      environment: {},
    });
    const view = await inspect(result.directory);
    expect(view.records).toHaveLength(8);
    expect(view.records.every((r) => r.scoring_status === "scored")).toBe(true);
  }
  expect(calls).toBe(16);
  expect(max).toBe(1);
  expect(identities.size).toBe(16);
});
test("model attempts and token thresholds include retries and stop subsequent dispatch", async () => {
  const { root, registry } = await setup(async (i) => ({
    ...submission(i.unit_id),
    usage: {
      source: "measured",
      attempts: 2,
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      unknown_attempts: 0,
      currency_cost: "not_computed",
    },
  }));
  const agent = registry.getAgent("fixture");
  agent.capabilities = {
    ...agent.capabilities,
    model: "configurable",
    model_budget: true,
    usage: "measured",
  };
  const c = config();
  const plan = await buildPlan(
    {
      ...c,
      agents: c.agents.map((a) => ({ ...a, model: profile })),
      task_budget: { timeout_ms: 1000, model_attempts: 3, total_tokens: 20 },
      batch_budget: { timeout_ms: 10000, model_attempts: 4, total_tokens: 25 },
    },
    registry,
  );
  const result = await runEvaluation(plan, registry, join(root, "runs"), {
    environment: {},
  });
  const view = await inspect(result.directory);
  expect(view.records[0]?.budget_status).toBe("exceeded");
  expect(view.records[1]?.execution_status).toBe("not_run");
  expect(result.status).toBe("incomplete");
});
test("unknown model usage, cleanup and record failures prevent more calls", async () => {
  for (const mode of ["unknown", "cleanup", "record"] as const) {
    let calls = 0;
    const { root, registry } = await setup(async (i) => {
      calls++;
      return {
        ...submission(i.unit_id),
        usage:
          mode === "unknown"
            ? { ...emptyUsage("unknown"), input_tokens: 4, total_tokens: 4 }
            : { ...emptyUsage("not_applicable"), source: "measured" },
        cleanup_error: mode === "cleanup" ? "cannot remove" : null,
        record_error: mode === "record",
      };
    });
    const agent = registry.getAgent("fixture");
    agent.capabilities = {
      ...agent.capabilities,
      model: "configurable",
      model_budget: true,
      usage: "measured",
    };
    const c = config();
    const budget = { timeout_ms: 10000, model_attempts: 4, total_tokens: 1000 };
    const plan = await buildPlan(
      {
        ...c,
        agents: c.agents.map((a) => ({ ...a, model: profile })),
        task_budget: budget,
        batch_budget: budget,
      },
      registry,
    );
    const result = await runEvaluation(plan, registry, join(root, "runs"), {
      environment: {},
    });
    const view = await inspect(result.directory);
    expect(calls).toBe(1);
    expect(view.records[1]?.execution_status).toBe("not_run");
    expect(result.status).toBe("incomplete");
  }
});
test("cancellation reaches current adapter and preserves unstarted plan units", async () => {
  let aborted = false;
  const controller = new AbortController();
  const { root, registry } = await setup(async (i, signal) => {
    setTimeout(() => controller.abort(), 5);
    await new Promise<void>((resolve) =>
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return submission(i.unit_id);
  });
  const result = await runEvaluation(
    await buildPlan(config(), registry),
    registry,
    join(root, "runs"),
    { environment: {}, signal: controller.signal },
  );
  const view = await inspect(result.directory);
  expect(aborted).toBe(true);
  expect(view.records[0]?.execution_status).toBe("cancelled");
  expect(view.records[1]?.execution_status).toBe("not_run");
});
