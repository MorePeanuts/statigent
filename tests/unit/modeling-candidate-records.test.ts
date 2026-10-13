import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET } from "../../src/agent/config";
import { Budget } from "../../src/modeling/budget";
import {
  applyCandidateUpdates,
  attachExperiment,
  type CandidateState,
  type CandidateUpdate,
} from "../../src/modeling/candidates";
import { validateFrozenModelingTask } from "../../src/modeling/config";
import { inspectModeling, ModelingRecord } from "../../src/modeling/records";
import { emptyLedger } from "../../src/records/agent-metadata";
import { RunRecorder } from "../../src/records/store";
import { collaborationMetadata } from "../helpers/collaboration";

const task = validateFrozenModelingTask({
  goal: "check records",
  dataset_root: ".",
  model_profile: "test",
  image: "test",
});
const create: CandidateUpdate = {
  op: "create",
  id: "c1",
  hypothesis: "ratios help",
  change: "add ratios",
  priority: 1,
  reason: "direct trial",
  evidence: [],
};
const train = (
  updates: CandidateUpdate[] = [],
  repair: string | null = null,
) => ({
  kind: "train",
  candidate_updates: updates,
  candidate_id: "c1",
  change: "try ratios",
  reason: "test",
  source_experiment: null,
  evidence: [],
  repair_of_experiment: repair,
  code: "def build_pipeline(seed): pass",
});
async function record() {
  return ModelingRecord.create(
    await mkdtemp(join(await realpath(tmpdir()), "candidate-record-")),
    { task, prompt: { version: "modeling-v2" } },
    1000000,
  );
}
async function save(
  r: ModelingRecord,
  candidates: CandidateState[],
  sequence: number,
  extra: Record<string, unknown> = {},
) {
  await r.save({
    status: "failed",
    candidate_control: { version: 1, candidates, applied_sequence: sequence },
    experiments: [],
    analyses: [],
    ...extra,
  });
}
async function accept(
  r: ModelingRecord,
  experiment = "e1",
  updates: CandidateUpdate[] = [create],
  repair: string | null = null,
) {
  return r.event(
    "action_accepted",
    {
      protocol_version: 2,
      attempt_id: "attempt",
      tool_id: `tool-${experiment}`,
      intent: {
        kind: "experiment",
        experiment_id: experiment,
        candidate_id: "c1",
        final: false,
        repair_of_experiment: repair,
      },
    },
    train(updates, repair),
  );
}
test("legacy inspection reports absent candidate control without changing bytes", async () => {
  const r = await ModelingRecord.create(
    await mkdtemp(join(await realpath(tmpdir()), "legacy-record-")),
    {},
    100000,
  );
  await r.event("run_started");
  const before = await readFile(join(r.directory, "modeling.json"));
  const view = await inspectModeling(r.directory);
  expect(view.candidate_control).toBe("not_recorded");
  expect(await readFile(join(r.directory, "modeling.json"))).toEqual(before);
});
test("accepted but unconfirmed execution is recoverable from journal even before snapshot save", async () => {
  const r = await record();
  await save(r, [], 0);
  const sequence = await accept(r);
  let view = await inspectModeling(r.directory);
  expect(view.unconfirmed_experiments).toHaveLength(1);
  expect(view.candidate_control).toMatchObject({
    snapshot_applied_sequence: 0,
    journal_applied_sequence: sequence,
    candidates: [{ id: "c1", status: "tried", experiment_ids: ["e1"] }],
  });
  const candidates = attachExperiment(
    applyCandidateUpdates([], [create], 16),
    "c1",
    "e1",
  );
  await save(r, candidates, sequence);
  view = await inspectModeling(r.directory);
  expect(view.candidate_control).toMatchObject({
    snapshot_applied_sequence: sequence,
  });
  const candidate = candidates[0];
  if (!candidate) throw new Error("Missing candidate");
  candidate.priority = 9;
  await save(r, candidates, sequence);
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "Candidate snapshot mismatch",
  );
});
test("repair history requires confirmed failed experiment and preserves distinct attempts", async () => {
  const r = await record();
  const first = await accept(r);
  await r.event("experiment_intent", {
    accepted_sequence: first,
    experiment_id: "e1",
    candidate_id: "c1",
    final: false,
    repair_of_experiment: null,
    retry: false,
  });
  await r.event("experiment_result", {
    experiment_id: "e1",
    status: "failed",
    rmse: null,
    reason: "error: invalid code",
  });
  const second = await accept(r, "e2", [], "e1");
  let candidates = attachExperiment(
    applyCandidateUpdates([], [create], 16),
    "c1",
    "e1",
  );
  candidates = attachExperiment(candidates, "c1", "e2");
  await save(r, candidates, second, {
    experiments: [
      {
        id: "e1",
        candidate_id: "c1",
        final: false,
        status: "failed",
        rmse: null,
        reason: "error: invalid code",
      },
    ],
  });
  const view = await inspectModeling(r.directory);
  expect(view.unconfirmed_experiments).toMatchObject([
    { experiment_id: "e2", repair_of_experiment: "e1" },
  ]);
  const broken = await record();
  await accept(broken);
  const seq = await accept(broken, "e2", [], "e1");
  await save(broken, candidates, seq);
  await expect(inspectModeling(broken.directory)).rejects.toThrow(
    "confirmed failed",
  );
});
test("unknown candidate extension and removed v2 extension cannot be treated as legacy", async () => {
  const r = await record();
  await r.event("run_started");
  await save(r, [], 0, {
    candidate_control: { version: 3, candidates: [], applied_sequence: 0 },
  });
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "Unsupported candidate control version",
  );
  const value = JSON.parse(
    await readFile(join(r.directory, "modeling.json"), "utf8"),
  );
  delete value.candidate_control;
  await writeFile(join(r.directory, "modeling.json"), JSON.stringify(value));
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "Missing candidate control",
  );
});
test("analysis request, allocation, empty undispatched result and actual accounting are distinct", async () => {
  const r = await record(),
    b = new Budget(task.budget, () => 800000);
  const requested = {
    task_timeout_ms: 10000,
    total_tokens: 1000,
    executions: 1,
  };
  const allocation = b.childBudget(requested);
  const request = {
    kind: "analyze",
    candidate_updates: [create],
    candidates: ["c1"],
    question: "ratios?",
    expected_evidence: "correlations",
    decision_rules: "test if useful",
    source_experiment: null,
    requested_budget: requested,
    budget_reason: "small diagnostic",
  };
  const intent = {
    kind: "analysis",
    analysis_id: "a1",
    child_id: "child1",
    allocation,
    started_at: "2026-10-13T00:00:00.000Z",
    deadline_at: "2026-10-13T00:00:10.000Z",
  };
  const seq = await r.event(
    "action_accepted",
    { protocol_version: 2, attempt_id: "attempt", tool_id: "tool", intent },
    request,
  );
  const candidates = applyCandidateUpdates([], [create], 16);
  await save(r, candidates, seq);
  expect(
    (await inspectModeling(r.directory)).unconfirmed_children,
  ).toHaveLength(1);
  await r.event("child_result", {
    analysis_id: "a1",
    child_id: "child1",
    status: "timed_out",
  });
  const a = {
    request,
    id: "a1",
    run_id: "child1",
    status: "timed_out",
    dispatch: "not_started",
    directory: null,
    effective_budget: allocation.effective,
    cost: emptyLedger(),
    role_usage: { planner: emptyLedger(), executor: emptyLedger() },
    executions: 0,
  };
  await save(r, candidates, seq, { analyses: [a], usage: b.snapshot() });
  expect(
    (await inspectModeling(r.directory)).unconfirmed_children,
  ).toHaveLength(0);
  a.request = { ...request, question: "tampered question" };
  await save(r, candidates, seq, { analyses: [a] });
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "Analysis request mismatch",
  );
  a.request = request;
  a.effective_budget = { ...allocation.effective, executions: 2 };
  await save(r, candidates, seq, { analyses: [a] });
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "effective budget mismatch",
  );
  const collaboration = collaborationMetadata();
  const child = await RunRecorder.create({
    runRoot: join(r.directory, "eda"),
    runId: "child1",
    config: {},
    inputs: [],
    image: { id: "fixture", platform: "linux/arm64" },
    agent: {
      model: collaboration.roles.planner.model,
      prompt: { version: "fixture", sha256: "a".repeat(64) },
      tokens: emptyLedger(),
      collaboration,
      metadata: {
        goal: "test",
        constraints: [],
        budget: { ...DEFAULT_BUDGET, ...allocation.effective },
        remaining: {
          model_attempts: allocation.effective.model_attempts,
          executions: 1,
          tokens: 1000,
          task_ms: 10000,
        },
        executions: 0,
        termination: null,
        final_result: null,
        trace_bytes: 0,
        trace_incomplete: false,
      },
    },
  });
  await child.finish("timed_out");
  const started = {
    ...a,
    effective_budget: allocation.effective,
    dispatch: "started",
    directory: child.directory,
  };
  await save(r, candidates, seq, { analyses: [started] });
  expect(
    (await inspectModeling(r.directory)).unconfirmed_children,
  ).toHaveLength(0);
  const native = JSON.parse(
    await readFile(join(child.directory, "manifest.json"), "utf8"),
  );
  native.status = "failed";
  await writeFile(
    join(child.directory, "manifest.json"),
    JSON.stringify(native),
  );
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "EDA child status mismatch",
  );
  // 即使父快照与动作都引用同一分析，数据身份仍须对照原任务。
  const eventPath = join(r.directory, "events.jsonl");
  await writeFile(
    eventPath,
    (await readFile(eventPath, "utf8")).replace(
      '"status":"timed_out"',
      '"status":"completed"',
    ),
  );
  const uses = [
    {
      analysis_id: "a1",
      source_experiment: null,
      refs: ["ref1"],
      applicability: "same data",
    },
  ];
  const sequence = await r.event(
    "action_accepted",
    {
      protocol_version: 2,
      attempt_id: "attempt2",
      tool_id: "train",
      intent: {
        kind: "experiment",
        experiment_id: "e1",
        candidate_id: "c1",
        final: false,
        repair_of_experiment: null,
      },
    },
    { ...train(), evidence: uses },
  );
  await save(r, attachExperiment(candidates, "c1", "e1"), sequence, {
    config: {
      task,
      prompt: { version: "modeling-v2" },
      dataset: { files: [{ sha256: "data" }], split: { sha256: "split" } },
    },
    analyses: [
      {
        ...started,
        status: "completed",
        source_experiment: null,
        dataset_hash: "different-data",
        split_hash: "split",
        analysis: { findings: [{ evidence_refs: ["ref1"] }] },
      },
    ],
  });
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "Candidate evidence dataset mismatch",
  );
});

test("two EDA allocations use current parent costs, and altered parent totals are rejected", async () => {
  const task2 = { ...task, budget: { ...task.budget, eda_calls: 2 } };
  const r = await ModelingRecord.create(
    await mkdtemp(join(await realpath(tmpdir()), "allocation-record-")),
    { task: task2, prompt: { version: "modeling-v2" } },
    1000000,
  );
  const b = new Budget(task2.budget, () => 800000),
    analyses: Record<string, unknown>[] = [];
  let candidates: CandidateState[] = [],
    seq = 0;
  for (let i = 0; i < 2; i++) {
    await r.event("model_request", { attempt_id: `attempt${i}` });
    b.modeling.attempts++;
    b.total.attempts++;
    const usage = {
      input_tokens: 200000,
      output_tokens: 0,
      status: "known" as const,
      total_tokens: 200000,
      cache_hit_tokens: null,
      cache_miss_tokens: null,
      reasoning_tokens: null,
      raw: null,
    };
    b.settleModel(usage, false, 0);
    await r.event("model_response", { attempt_id: `attempt${i}`, usage });
    const requested = {
      task_timeout_ms: 10000 * (i + 1),
      total_tokens: 300000,
      executions: i + 1,
    };
    const allocation = b.childBudget(requested),
      id = `a${i}`,
      child = `child${i}`;
    const updates = i === 0 ? [create] : [];
    const request = {
      kind: "analyze",
      candidate_updates: updates,
      candidates: ["c1"],
      question: "ratios?",
      expected_evidence: "correlations",
      decision_rules: "test if useful",
      source_experiment: null,
      requested_budget: requested,
      budget_reason: "small diagnostic",
    };
    seq = await r.event(
      "action_accepted",
      {
        protocol_version: 2,
        attempt_id: `attempt${i}`,
        tool_id: `tool${i}`,
        intent: {
          kind: "analysis",
          analysis_id: id,
          child_id: child,
          allocation,
          started_at: "2026-10-13T00:00:00.000Z",
          deadline_at: new Date(
            Date.parse("2026-10-13T00:00:00.000Z") + requested.task_timeout_ms,
          ).toISOString(),
        },
      },
      request,
    );
    candidates = applyCandidateUpdates(candidates, updates, 16);
    b.edaCalls++;
    await r.event("child_result", {
      analysis_id: id,
      child_id: child,
      status: "timed_out",
    });
    const roles = { planner: emptyLedger(), executor: emptyLedger() };
    analyses.push({
      request,
      id,
      run_id: child,
      status: "timed_out",
      dispatch: "not_started",
      directory: null,
      effective_budget: allocation.effective,
      cost: emptyLedger(),
      role_usage: roles,
      executions: 0,
    });
    b.settleChild(child, emptyLedger(), 0, roles);
  }
  await save(r, candidates, seq, { analyses, usage: b.snapshot() });
  const view = await inspectModeling(r.directory);
  expect(view.candidate_control).toMatchObject({
    analyses: [
      {
        allocation: { effective: { total_tokens: 300000, executions: 1 } },
        cost: { total_tokens: 0 },
        settlement: "confirmed",
      },
      {
        allocation: { effective: { total_tokens: 200000, executions: 2 } },
        cost: { total_tokens: 0 },
        settlement: "confirmed",
      },
    ],
  });
  const usage = structuredClone(b.snapshot());
  usage.tokens.input_tokens++;
  usage.tokens.total_tokens++;
  await save(r, candidates, seq, { analyses, usage });
  await expect(inspectModeling(r.directory)).rejects.toThrow(
    "Parent accounting mismatch",
  );
});
