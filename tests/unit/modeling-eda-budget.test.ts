import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { runAgent } from "../../src/agent/run";
import { Budget } from "../../src/modeling/budget";
import {
  MODELING_BUDGET,
  validateModelingTask,
} from "../../src/modeling/config";
import { loadDataset, prepareDataset } from "../../src/modeling/data";
import { analyze } from "../../src/modeling/eda";
import { ModelFailure } from "../../src/models/client";
import { obj } from "../../src/models/validation";
import { exportNotebooks } from "../../src/records/notebook";
import {
  call,
  fakeRuntime,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function options(): Promise<Parameters<typeof analyze>[0]> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "eda-budget-"));
  roots.push(root);
  await prepareDataset(source, join(root, "data"));
  const data = await loadDataset(join(root, "data"));
  const budget = {
    model_attempts: 4,
    total_tokens: 100,
    executions: 2,
    task_timeout_ms: 10000,
  };
  return {
    id: "analysis-1",
    runId: "child-1",
    root,
    task: validateModelingTask({
      schema_version: 2,
      method: "adaptive_eda",
      confirmation: { mode: "none" },
      resource_version: "smoke-v1",

      goal: "test",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
    }),
    dataset: data.dataset,
    train: data.train,
    experiment: null,
    request: {
      kind: "analyze",
      candidate_updates: [],
      candidates: ["c1"],
      question: "Inspect x",
      expected_evidence: "x distribution",
      purpose: "explore",
      source_experiments: [],
    },
    resolvedCandidates: [
      {
        id: "c1",
        hypothesis: "x is skewed",
        change: "transform x",
        priority: 1,
      },
    ],
    profile,
    signal: new AbortController().signal,
    budget,
    deadline: performance.now() + 10000,
  };
}
test("EDA input preparation consumes the original deadline and pre-dispatch stops have known zero cost", async () => {
  const o = await options();
  let clock = 100,
    dispatches = 0;
  o.deadline = 200;
  o.now = () => clock;
  o.prepare = async () => {
    clock = 201;
    return [];
  };
  o.run = async () => {
    dispatches++;
    throw new Error("must not dispatch");
  };
  const result = await analyze(o);
  expect(result).toMatchObject({
    status: "timed_out",
    dispatch: "not_started",
    directory: null,
    executions: 0,
    cost: { status: "known", attempts: 0, total_tokens: 0 },
  });
  expect(dispatches).toBe(0);
  const controller = new AbortController();
  o.signal = controller.signal;
  o.now = () => 100;
  o.prepare = async () => {
    controller.abort();
    return [];
  };
  expect(await analyze(o)).toMatchObject({
    status: "cancelled",
    dispatch: "not_started",
    directory: null,
  });
  expect(dispatches).toBe(0);
});
test("EDA distinguishes preparation failure from unconfirmed dispatch and sends resolved candidates plus original allocation", async () => {
  const o = await options();
  o.prepare = async () => {
    throw new Error("input unavailable");
  };
  expect(await analyze(o)).toMatchObject({
    status: "failed",
    dispatch: "not_started",
    cost: { status: "known", total_tokens: 0 },
  });
  delete o.prepare;
  o.run = async (child) => {
    expect(child.deadline).toBe(o.deadline);
    const task = obj(child.task);
    expect(obj(task.budget)).toMatchObject(o.budget);
    expect(obj(JSON.parse(String(task.goal))).candidates).toEqual(
      o.resolvedCandidates,
    );
    throw new Error("unconfirmed dispatch");
  };
  await expect(analyze(o)).rejects.toThrow("unconfirmed dispatch");
});
test("complete EDA role loop retains actual token overshoot then stops; unknown consumption stops parent", async () => {
  for (const unknown of [false, true]) {
    const o = await options(),
      runtime = fakeRuntime();
    o.budget.total_tokens = 100000;
    const client = new ScriptClient(() => {
      if (unknown) throw new ModelFailure("connection_lost", "unknown");
      return reply(
        [call("delegate_analysis", { task: "Inspect x", constraints: [] })],
        { usage: { prompt_tokens: 90000, completion_tokens: 20000 } },
      );
    });
    o.client = client;
    o.run = (child) =>
      runAgent({
        ...child,
        createSession: runtime.createSession,
        export: (dir, _, status) =>
          exportNotebooks(dir, async () => {}, status),
      });
    const result = await analyze(o);
    expect(result.dispatch).toBe("started");
    expect(result.effective_budget).toEqual(o.budget);
    expect(client.bodies).toHaveLength(1);
    expect(runtime.state.closed).toBe(1);
    const parent = new Budget(MODELING_BUDGET, () => 800000);
    if (unknown) {
      expect(result.cost.status).toBe("unknown");
      expect(() =>
        parent.settleChild(
          result.run_id,
          result.cost,
          result.executions,
          result.role_usage,
        ),
      ).toThrow("accounting_incomplete");
      expect(() => parent.hostChildBudget()).toThrow("accounting_incomplete");
    } else {
      expect(result.status).toBe("budget_exhausted");
      expect(result.cost.total_tokens).toBe(110000);
      expect(result.role_usage.planner.total_tokens).toBe(110000);
      expect(result.role_usage.executor.total_tokens).toBe(0);
      parent.settleChild(
        result.run_id,
        result.cost,
        result.executions,
        result.role_usage,
      );
      expect(parent.total.total_tokens).toBe(110000);
    }
  }
});
