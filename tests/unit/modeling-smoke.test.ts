import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../../src/modeling/budget";
import { MODELING_BUDGET } from "../../src/modeling/config";
import { auditCollaboration, writeSmokeReport } from "../../src/modeling/smoke";
import { obj } from "../../src/models/validation";

function fixture(repair = false) {
  const allocation = new Budget(MODELING_BUDGET, () => 800000).childBudget({
    task_timeout_ms: 10000,
    total_tokens: 100000,
    executions: 2,
  });
  const evidence = [
    {
      analysis_id: "eda",
      source_experiment: "a",
      refs: ["ref"],
      applicability: "current split",
    },
  ];
  const experiments: Record<string, unknown>[] = [
    { id: "a", candidate_id: "same", final: false, status: "completed" },
    ...(repair
      ? [{ id: "failed", candidate_id: "same", final: false, status: "failed" }]
      : []),
    { id: "b", candidate_id: "same", final: false, status: "completed" },
    { id: "c", candidate_id: "same", final: true, status: "completed" },
  ];
  const manifest = {
    status: "completed",
    candidate_control: { version: 1, candidates: [{ id: "same" }] },
    experiments,
    analyses: [
      {
        id: "eda",
        run_id: "child",
        source_experiment: "a",
        status: "completed",
        dispatch: "started",
        effective_budget: allocation.effective,
        cost: { total_tokens: 60 },
      },
    ],
  };
  const events: Record<string, unknown>[] = [],
    actions: Record<string, unknown>[] = [];
  const accepted = (
    intent: Record<string, unknown>,
    action: Record<string, unknown>,
  ) => {
    actions.push(action);
    events.push({ type: "action_accepted", protocol_version: 2, intent });
  };
  accepted(
    { kind: "experiment", experiment_id: "a", candidate_id: "same" },
    {
      kind: "train",
      candidate_id: "same",
      candidate_updates: [{ op: "create", id: "same", evidence: [] }],
      evidence: [],
    },
  );
  events.push(
    {
      type: "experiment_intent",
      experiment_id: "a",
      candidate_id: "same",
      final: false,
    },
    { type: "experiment_result", experiment_id: "a", status: "completed" },
  );
  accepted(
    { kind: "analysis", analysis_id: "eda", child_id: "child", allocation },
    {
      kind: "analyze",
      requested_budget: allocation.requested,
      budget_reason: "focused question",
      candidate_updates: [],
    },
  );
  events.push({
    type: "child_result",
    analysis_id: "eda",
    status: "completed",
  });
  accepted(
    {
      kind: "experiment",
      experiment_id: repair ? "failed" : "b",
      candidate_id: "same",
    },
    {
      kind: "train",
      candidate_id: "same",
      candidate_updates: [
        {
          op: "update",
          id: "same",
          priority: 1,
          evidence,
          reason: "prioritize based on observation",
        },
      ],
      evidence,
      repair_of_experiment: null,
    },
  );
  if (repair) {
    events.push(
      {
        type: "experiment_intent",
        experiment_id: "failed",
        candidate_id: "same",
        final: false,
      },
      { type: "experiment_result", experiment_id: "failed", status: "failed" },
    );
    accepted(
      { kind: "experiment", experiment_id: "b", candidate_id: "same" },
      {
        kind: "train",
        candidate_id: "same",
        candidate_updates: [],
        evidence: [],
        repair_of_experiment: "failed",
      },
    );
  }
  events.push(
    {
      type: "experiment_intent",
      experiment_id: "b",
      candidate_id: "same",
      final: false,
    },
    { type: "experiment_result", experiment_id: "b", status: "completed" },
  );
  return { manifest, events, actions };
}
test("smoke follows accepted experiment identity, including failed then repaired attempts of the same candidate", () => {
  for (const repair of [false, true]) {
    const f = fixture(repair);
    expect(auditCollaboration(f.manifest, f.events, f.actions)).toMatchObject({
      analysis_id: "eda",
      followup_candidate: "same",
      followup_experiment: "b",
      evidence_experiment: repair ? "failed" : "b",
    });
    const follow = f.events.find(
      (e) => e.type === "experiment_intent" && e.experiment_id === "b",
    );
    if (!follow) throw Error("fixture");
    follow.experiment_id = "unrelated";
    expect(() => auditCollaboration(f.manifest, f.events, f.actions)).toThrow(
      "order",
    );
  }
});
test("smoke rejects prose-only candidate updates, unrelated evidence, and missing actual budget propagation", () => {
  const prose = fixture();
  const action = prose.actions[2];
  if (!action) throw Error("fixture");
  action.candidate_updates = [];
  action.reason = "EDA changed candidate priority";
  expect(() =>
    auditCollaboration(prose.manifest, prose.events, prose.actions),
  ).toThrow("candidate updates");
  const missing = fixture();
  if (!missing.actions[2]) throw Error("fixture");
  missing.actions[2].evidence = [];
  expect(() =>
    auditCollaboration(missing.manifest, missing.events, missing.actions),
  ).toThrow("evidence-linked");
  const budget = fixture();
  if (!budget.manifest.analyses[0]) throw Error("fixture");
  budget.manifest.analyses[0].effective_budget = {
    ...budget.manifest.analyses[0].effective_budget,
    total_tokens: 2,
  };
  expect(() =>
    auditCollaboration(budget.manifest, budget.events, budget.actions),
  ).toThrow("effective budget");
  const requested = fixture();
  if (!requested.actions[1]) throw Error("fixture");
  requested.actions[1].requested_budget = {
    task_timeout_ms: 1,
    total_tokens: 1,
    executions: 1,
  };
  expect(() =>
    auditCollaboration(requested.manifest, requested.events, requested.actions),
  ).toThrow("requested budget");
});
test("smoke rejects wrong order, incomplete runs, failed repairs and missing candidate protocol", () => {
  const f = fixture(true);
  expect(() =>
    auditCollaboration(
      f.manifest,
      [...f.events].reverse(),
      [...f.actions].reverse(),
    ),
  ).toThrow("order");
  expect(() =>
    auditCollaboration({ ...f.manifest, analyses: [] }, f.events, f.actions),
  ).toThrow("EDA");
  expect(() =>
    auditCollaboration(
      { ...f.manifest, status: "failed" },
      f.events,
      f.actions,
    ),
  ).toThrow("complete");
  expect(() => auditCollaboration(f.manifest, f.events, [])).toThrow("payload");
  const failure = f.manifest.experiments.find((e) => e.id === "failed");
  if (!failure) throw Error("fixture");
  failure.candidate_id = "different";
  expect(() => auditCollaboration(f.manifest, f.events, f.actions)).toThrow(
    "evidence-linked",
  );
  const accepted = f.events.find((e) => e.type === "action_accepted");
  if (!accepted) throw Error("fixture");
  accepted.protocol_version = 1;
  expect(() => auditCollaboration(f.manifest, f.events, f.actions)).toThrow(
    "protocol",
  );
});
test("smoke preserves the first failed report when later review succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smoke-report-"));
  try {
    await writeSmokeReport(directory, {
      status: "failed",
      reason: "original validator error",
    });
    const before = await readFile(join(directory, "smoke-result.json"));
    await expect(
      writeSmokeReport(directory, { status: "passed" }),
    ).rejects.toThrow();
    expect(await readFile(join(directory, "smoke-result.json"))).toEqual(
      before,
    );
    expect(obj(JSON.parse(before.toString())).status).toBe("failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
