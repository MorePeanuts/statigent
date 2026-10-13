import { expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, validateAllocation } from "../../src/modeling/budget";
import { modelingMain } from "../../src/modeling/cli";
import { MODELING_BUDGET } from "../../src/modeling/config";
import { inspectModeling, ModelingRecord } from "../../src/modeling/records";
import { emptyLedger } from "../../src/records/agent-metadata";

test("parent child budgets settle once, reserve final work and fail on unknown costs", () => {
  let remaining = 800000;
  const b = new Budget({ ...MODELING_BUDGET, eda_calls: 2 }, () => remaining);
  const child = {
    ...emptyLedger(),
    attempts: 3,
    input_tokens: 20,
    output_tokens: 10,
    total_tokens: 30,
  };
  b.settleChild("a", child, 2);
  b.settleChild("a", child, 2);
  expect(b.total.total_tokens).toBe(30);
  expect(b.edaExecutions).toBe(2);
  expect(
    b.childBudget({
      task_timeout_ms: 300000,
      total_tokens: 400000,
      executions: 10,
    }).effective.executions,
  ).toBe(8);
  for (let i = 0; i < 3; i++) b.train(false);
  expect(() => b.train(false)).toThrow();
  b.train(true);
  expect(() => b.train(true)).toThrow();
  remaining = 170000;
  expect(() =>
    b.childBudget({
      task_timeout_ms: 300000,
      total_tokens: 400000,
      executions: 10,
    }),
  ).toThrow();
  expect(() =>
    b.settleChild(
      "b",
      { ...emptyLedger(), attempts: 1, unknown_attempts: 1, status: "unknown" },
      0,
    ),
  ).toThrow("accounting_incomplete");
});
test("EDA allocation clips each constraint without charging requested resources or changing training", () => {
  let remaining = 800000.7;
  const b = new Budget({ ...MODELING_BUDGET, eda_calls: 2 }, () => remaining);
  const request = { task_timeout_ms: 10000, total_tokens: 300, executions: 3 };
  const before = JSON.stringify(b.snapshot());
  const first = b.childBudget(request);
  expect(first.effective).toEqual({ ...request, model_attempts: 20 });
  expect(first.clipped).toEqual([]);
  expect(validateAllocation(first)).toEqual(first);
  b.canTrain(false);
  expect(JSON.stringify(b.snapshot())).toBe(before);
  b.edaCalls++;
  b.settleChild(
    "first",
    { ...emptyLedger(), input_tokens: 150, total_tokens: 150, attempts: 3 },
    2,
  );
  expect(b.total.total_tokens).toBe(150);
  remaining = 185001.8;
  const second = b.childBudget({
    task_timeout_ms: 400000,
    total_tokens: 800000,
    executions: 20,
  });
  expect(second.effective).toEqual({
    task_timeout_ms: 5001,
    total_tokens: 400000,
    executions: 8,
    model_attempts: 20,
  });
  expect(second.clipped).toContainEqual({
    dimension: "total_tokens",
    constraint: "remaining",
    limit: 599850,
  });
  expect(second.clipped).toContainEqual({
    dimension: "task_timeout_ms",
    constraint: "configured",
    limit: 300000,
  });
  expect(validateAllocation(second)).toEqual(second);
  expect(() =>
    validateAllocation({
      ...second,
      effective: { ...second.effective, executions: 9 },
    }),
  ).toThrow();
  expect(() => validateAllocation({ ...second, clipped: [] })).toThrow();
  expect(() =>
    validateAllocation({
      ...second,
      remaining: { ...second.remaining, parent_task_ms: 185002 },
    }),
  ).toThrow();
  b.edaExecutions = 10;
  expect(() => b.childBudget(request)).toThrow("executions");
  expect(b.training).toBe(0);
});
test("EDA invalid requests and parent stops reject pure preflight", () => {
  const b = new Budget(MODELING_BUDGET, () => 800000);
  const request = { task_timeout_ms: 100, total_tokens: 100, executions: 1 };
  for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    for (const key of Object.keys(request))
      expect(() => b.childBudget({ ...request, [key]: value })).toThrow();
  expect(() =>
    b.childBudget({ ...request, extra: 1 } as typeof request),
  ).toThrow("Unsupported");
  b.total.attempts = MODELING_BUDGET.model_attempts;
  expect(() => b.childBudget(request)).toThrow("model_attempts");
  expect(b.edaCalls).toBe(0);
  b.total.total_tokens = MODELING_BUDGET.total_tokens + 1;
  expect(() => b.childBudget(request)).toThrow("token_threshold");
});
test("child settlement checks roles and execution identity, never truncating overshoot", () => {
  const b = new Budget({ ...MODELING_BUDGET, total_tokens: 100 }, () => 800000);
  const planner = {
    ...emptyLedger(),
    attempts: 1,
    input_tokens: 40,
    total_tokens: 40,
    elapsed_ms: 0.1,
  };
  const executor = {
    ...emptyLedger(),
    attempts: 1,
    output_tokens: 70,
    total_tokens: 70,
    elapsed_ms: 0.2,
  };
  const total = {
    ...emptyLedger(),
    attempts: 2,
    input_tokens: 40,
    output_tokens: 70,
    total_tokens: 110,
    elapsed_ms: 0.3,
  };
  expect(() =>
    b.settleChild("x", total, 1, { planner, executor: planner }),
  ).toThrow("role accounting");
  expect(b.children.size).toBe(0);
  expect(() => b.settleChild("x", total, 1, { planner, executor })).toThrow(
    "token_threshold",
  );
  expect(b.total.total_tokens).toBe(110);
  b.settleChild("x", total, 1, { planner, executor });
  expect(b.total.total_tokens).toBe(110);
  expect(() => b.settleChild("x", total, 2, { planner, executor })).toThrow(
    "Conflicting",
  );
  expect(b.edaExecutions).toBe(1);
});
test("parent journal links unresolved children, detects tampering and latches record failures", async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "modeling-record-"),
  );
  const r = await ModelingRecord.create(root, {}, 100000);
  await r.event("child_intent", { child_id: "eda-1" }, { scope: "allowed" });
  let view = await inspectModeling(r.directory);
  expect(view.unconfirmed_children).toHaveLength(1);
  await r.event("child_result", { child_id: "eda-1" });
  view = await inspectModeling(r.directory);
  expect(view.unconfirmed_children).toHaveLength(0);
  expect(await modelingMain(["inspect", "--run", r.directory])).toEqual(view);
  await writeFile(join(r.directory, "payloads/1.json"), "tampered");
  await expect(inspectModeling(r.directory)).rejects.toThrow("integrity");
  const fail = await ModelingRecord.create(root, {}, 1);
  await expect(fail.event("intent")).rejects.toThrow();
  await expect(fail.event("dispatch")).rejects.toThrow("record_failure");
});

test("host allocation records no model request and recomputes remaining caps without precharging", async () => {
  const { validateHostAllocation } = await import("../../src/modeling/budget");
  let remaining = 500000;
  const budget = new Budget(
    { ...MODELING_BUDGET, eda_calls: 2 },
    () => remaining,
  );
  const first = budget.hostChildBudget();
  expect(first.policy).toBe("host-cap-v1");
  expect("requested" in first).toBe(false);
  expect(validateHostAllocation(first)).toEqual(first);
  expect(budget.total.attempts).toBe(0);
  budget.settleChild(
    "a",
    {
      ...emptyLedger(),
      attempts: 2,
      input_tokens: 30,
      output_tokens: 10,
      total_tokens: 40,
    },
    3,
  );
  remaining = 200000;
  const second = budget.hostChildBudget();
  expect(second.effective.task_timeout_ms).toBe(20000);
  expect(second.effective.executions).toBe(7);
  expect(() =>
    validateHostAllocation({
      ...second,
      effective: { ...second.effective, executions: 8 },
    }),
  ).toThrow();
  remaining = MODELING_BUDGET.final_reserve_ms;
  expect(() => budget.hostChildBudget()).toThrow();
});
