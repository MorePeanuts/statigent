import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelingAdapter,
  modelingParentUsage,
} from "../../src/evaluation/agents/modeling";
import { nativeModelingPublication } from "../../src/evaluation/benchmarks/modeling/publication";
import type { Invocation } from "../../src/evaluation/contracts";
import { buildPlan, Registry } from "../../src/evaluation/plan";
import { inspect } from "../../src/evaluation/records";
import { runEvaluation } from "../../src/evaluation/run";
import {
  MODELING_METHODS,
  validateBenchmarkModelingTask,
} from "../../src/modeling/config";
import { prepareExecutionSeed } from "../../src/modeling/execution-seed";
import { emptyLedger } from "../../src/records/agent-metadata";
import { ScriptClient } from "../helpers/agent";
import { fixtureRegistry } from "../helpers/evaluation";
import {
  modelingInvocation,
  modelingSettings,
} from "../helpers/evaluation-modeling";

let root: string, invocation: Invocation;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "modeling-adapter-")));
  invocation = await modelingInvocation(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const tokens = {
  ...emptyLedger(),
  attempts: 3,
  input_tokens: 80,
  output_tokens: 20,
  total_tokens: 100,
};
const view = {
  manifest: { usage: { tokens, children: [{ tokens }] } },
  unconfirmed_children: [],
  unconfirmed_experiments: [],
};
const failed = {
  run_id: "native-test",
  directory: "/owned/native-test",
  status: "failed",
  reason: "controlled",
  best_experiment_id: null,
  record_error: false,
};

test("all four methods use effective parent caps and only settle the audited parent ledger", async () => {
  for (const method of MODELING_METHODS) {
    let called = 0;
    const adapter = modelingAdapter({
      run: async (o) => {
        called++;
        const task = validateBenchmarkModelingTask(o.task);
        expect(task.method).toBe(method);
        expect(task.budget.model_attempts).toBe(7);
        expect(task.budget.total_tokens).toBe(500);
        expect(task.budget.task_timeout_ms).toBeLessThanOrEqual(300000);
        expect(task.budget.final_reserve_ms).toBe(100000);
        expect(o.profile).toEqual(o.edaProfile);
        expect(o.benchmark?.inputAccess).toBe("training");
        return failed;
      },
      inspect: async () => view,
    });
    const result = await adapter.run({
      ...invocation,
      config: {
        ...invocation.config,
        options: { ...modelingSettings, method },
      },
      budget: { timeout_ms: 300000, model_attempts: 7, total_tokens: 500 },
    });
    expect(called).toBe(1);
    expect(result.usage.total_tokens).toBe(100);
    expect(result.usage.attempts).toBe(3);
    expect(result.record_error).toBe(false);
  }
});

test("insufficient confirmation reserve stops before data preparation or first model call", async () => {
  let calls = 0;
  const adapter = modelingAdapter({
    run: async () => {
      calls++;
      return failed;
    },
    publication: async () => {
      throw new Error("must not publish");
    },
  });
  const result = await adapter.run({
    ...invocation,
    budget: { ...invocation.budget, timeout_ms: 99000 },
  });
  expect(result.reason).toContain("reserve");
  expect(result.usage.attempts).toBe(0);
  expect(result.usage.source).toBe("measured");
  expect(calls).toBe(0);
  expect(() =>
    adapter.options({
      ...modelingSettings,
      confirmation: { mode: "terminal_repeated_holdout" },
    }),
  ).toThrow("reserve");
});

test("unknown native usage stops later units while preserving measured parent totals", async () => {
  let calls = 0;
  const registry = new Registry();
  const base = fixtureRegistry(root).getBenchmark("synthetic");
  registry.benchmark({
    ...base,
    catalog: async () => ({
      tasks: [invocation.task, { ...invocation.task, id: "second" }],
      source_root: root,
      provenance: { version: "v1" },
    }),
  });
  registry.agent(
    modelingAdapter({
      run: async () => {
        calls++;
        return failed;
      },
      inspect: async () => ({
        ...view,
        manifest: {
          usage: {
            tokens: { ...tokens, status: "unknown", unknown_attempts: 1 },
          },
        },
      }),
      image: async () => ({
        id: `sha256:${"a".repeat(64)}`,
        platform: "linux/arm64",
      }),
      overrides: {
        client: new ScriptClient(() => {
          throw new Error("no API");
        }),
      },
    }),
  );
  const plan = await buildPlan(
    {
      schema_version: 3,
      cache_policy: "disabled",
      purpose: "development",
      development_overlap: "synthetic only",
      benchmark: {
        adapter: "synthetic",
        version: "v1",
        options: {},
        task_ids: [invocation.task.id, "second"],
      },
      agents: [invocation.config],
      seed: 17,
      repetitions: 1,
      task_budget: invocation.budget,
      batch_budget: invocation.budget,
    },
    registry,
  );
  const run = await runEvaluation(plan, registry, join(root, "batch"), {
    environment: {},
  });
  const result = await inspect(run.directory);
  expect(calls).toBe(1);
  expect(result.records[0]?.budget_status).toBe("unknown");
  expect(result.records[1]?.reason).toBe("unknown_model_usage");
  expect(result.records[1]?.execution_status).toBe("not_run");
});

test("deterministic mode rejects paid usage and unsupported methods", () => {
  expect(() => modelingParentUsage(view.manifest.usage, true)).toThrow(
    "unexpected model usage",
  );
  expect(() =>
    modelingAdapter({ deterministic: true }).options({
      ...modelingSettings,
      method: "collaborative",
    }),
  ).toThrow("no_eda");
});

test("seed preparation bridge binds the actual execution seed and preserves outer references", async () => {
  const original = await nativeModelingPublication(invocation);
  const derived = await prepareExecutionSeed({
    root: invocation.run_root,
    sourceRoot: original.root,
    dataset: original.dataset,
    seed: 42,
    timeout_ms: 10000,
  });
  expect(derived.dataset.seed).toBe(42);
  expect(derived.dataset.provenance.execution_seed_source).toBe(
    original.dataset.dataset_sha256,
  );
  expect(derived.dataset.training).toEqual(original.dataset.training);
  expect(derived.dataset.prediction).toEqual(original.dataset.prediction);
  expect(
    await Bun.file(join(derived.root, "evaluator/labels.csv")).exists(),
  ).toBe(false);
});
