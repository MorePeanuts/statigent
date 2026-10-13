import { expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../../src/modeling/budget";
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
  expect(b.childBudget().executions).toBe(8);
  for (let i = 0; i < 3; i++) b.train(false);
  expect(() => b.train(false)).toThrow();
  b.train(true);
  expect(() => b.train(true)).toThrow();
  remaining = 170000;
  expect(() => b.childBudget()).toThrow();
  expect(() =>
    b.settleChild(
      "b",
      { ...emptyLedger(), attempts: 1, unknown_attempts: 1, status: "unknown" },
      0,
    ),
  ).toThrow("accounting_incomplete");
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
