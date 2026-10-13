import { expect, test } from "bun:test";
import { modelingTools } from "../../src/modeling/actions";
import {
  validateModelingTask,
  validateRecordedModelingTask,
} from "../../src/modeling/config";
import { createProtocol } from "../../src/modeling/protocol";
import {
  acceptAttachments,
  bindSource,
  NOTE_BYTES,
  parseCore,
  parseDeliveryState,
  parseSearchEnd,
  type SourceContext,
  validateCore,
} from "../../src/modeling/workflow";
import { sha256 } from "../../src/records/store";

function context(): SourceContext {
  const protocol = createProtocol("regression", "rmse", [], null, "id");
  const profile = {
    generator: "basic-profile-v1",
    identity: {
      train_sha256: "a".repeat(64),
      members_sha256: "b".repeat(64),
      split_sha256: "c".repeat(64),
      protocol_sha256: protocol.protocol_sha256,
    },
    rows: 10,
    column_count: 0,
    missing_policy: "empty-string-only",
    limits: { columns: 128, category_values: 10, text_characters: 128 },
    columns: [],
  };
  return {
    run_id: "task-a",
    protocol,
    profile,
    profile_sha256: sha256(Buffer.from(JSON.stringify(profile))),
    experiments: [],
    analyses: [],
  };
}
const train = {
  code: "def build_pipeline(seed): pass",
  change: "initial",
  reason: "test data",
};
test("new task semantics are explicit and historical tasks are only parsed through the recorded boundary", () => {
  const v2 = {
    schema_version: 2,
    method: "no_eda",
    confirmation: { mode: "none" },
    resource_version: "old",
    goal: "predict",
    dataset_root: "runs/data",
    model_profile: "test",
    image: "test",
  };
  const before = JSON.stringify(v2);
  expect(validateRecordedModelingTask(v2).schema_version).toBe(2);
  expect(() => validateModelingTask(v2)).toThrow("Migrate");
  const v3 = { ...v2, schema_version: 3, budget: { training_attempts: null } };
  expect(validateModelingTask(v3).budget.training_attempts).toBeNull();
  for (const schema_version of [4, "3", undefined])
    expect(() => validateModelingTask({ ...v3, schema_version })).toThrow();
  expect(() =>
    validateRecordedModelingTask({
      ...v2,
      budget: { training_attempts: null },
    }),
  ).toThrow();
  expect(JSON.stringify(v2)).toBe(before);
});
test("minimal tools need no candidate transactions, analysis references or best model ID", () => {
  const core = parseCore("run_experiment", train, 1000, "no_eda");
  expect(core.kind).toBe("train");
  validateCore(core, []);
  expect(
    parseCore("finish_modeling", { reason: "done" }, 1000, "no_eda"),
  ).toEqual({ kind: "finish", reason: "done" });
  const tools = modelingTools(context().protocol, "collaborative");
  expect(tools.map((t) => t.function.parameters.required)).toEqual([
    ["code", "change", "reason"],
    ["question"],
    ["reason"],
  ]);
  expect(JSON.stringify(tools)).not.toContain("candidate_updates");
  expect(() =>
    parseCore("analyze", { question: "why" }, 1000, "no_eda"),
  ).toThrow("disabled");
  expect(() =>
    parseCore(
      "run_experiment",
      { ...train, repair_of_experiment: 3 },
      1000,
      "no_eda",
    ),
  ).toThrow();
  expect(() =>
    validateCore(
      parseCore(
        "run_experiment",
        { ...train, repair_of_experiment: "absent" },
        1000,
        "no_eda",
      ),
      [],
    ),
  ).toThrow("Unknown");
});
test("invalid optional references and notes cannot block a valid core and never become evidence", () => {
  const ctx = context(),
    core = parseCore("run_experiment", train, 1000, "collaborative");
  const accepted = acceptAttachments(
    core,
    {
      ...train,
      sources: [
        { source_id: "analysis:invented:0" },
        { source_id: "profile:/rows" },
      ],
      notes: {
        text: "unsupported",
        sources: [{ source_id: "analysis:unfinished:0" }],
      },
    },
    "collaborative",
    ctx,
    null,
    7,
  );
  expect(accepted.core).toEqual(core);
  expect(accepted.sources).toHaveLength(1);
  expect(accepted.sources[0]?.binding.run_id).toBe("task-a");
  expect(accepted.notes).toBeNull();
  expect(accepted.warnings.map((w) => w.field)).toEqual([
    "sources[0]",
    "notes",
  ]);
  expect(() => bindSource({ source_id: "profile:/absent" }, ctx)).toThrow();
});
test("notes retain, replace and clear without model maintained revisions; other methods cannot acquire notes", () => {
  const ctx = context(),
    core = parseCore("analyze", { question: "why" }, 1000, "collaborative");
  const first = acceptAttachments(
    core,
    {
      notes: { text: "Hypothesis", sources: [{ source_id: "profile:/rows" }] },
    },
    "collaborative",
    ctx,
    null,
    1,
  ).notes;
  expect(first?.revision).toBe(1);
  expect(
    acceptAttachments(core, {}, "collaborative", ctx, first, 2).notes,
  ).toBeNull();
  const clear = acceptAttachments(
    core,
    { notes: { text: "" } },
    "collaborative",
    ctx,
    first,
    3,
  );
  expect(clear.notes).toMatchObject({ revision: 2, text: "", sequence: 3 });
  expect(
    acceptAttachments(
      core,
      { notes: { text: "x".repeat(NOTE_BYTES + 1) } },
      "collaborative",
      ctx,
      first,
      4,
    ).notes,
  ).toBeNull();
  expect(
    acceptAttachments(
      core,
      { notes: { text: "not enabled" } },
      "adaptive_eda",
      ctx,
      null,
      1,
    ).warnings,
  ).toHaveLength(1);
});
test("search and delivery states reject missing or unknown states instead of guessing completion", () => {
  expect(
    parseSearchEnd({ kind: "protected", reason: "accounting_incomplete" }),
  ).toMatchObject({ kind: "protected" });
  expect(
    parseDeliveryState({ status: "completed", artifact: { schema_version: 4 } })
      .status,
  ).toBe("completed");
  for (const x of [undefined, {}, { kind: "complete", reason: "ok" }])
    expect(() => parseSearchEnd(x)).toThrow();
  for (const x of [
    { status: "completed" },
    { status: "completed", artifact: null },
    { status: "other", artifact: null },
  ])
    expect(() => parseDeliveryState(x)).toThrow();
});

test("finding handles preserve original exploration provenance and reject cross-task and failed sources", () => {
  const ctx = context();
  const analysis = {
    id: "a",
    run_id: "child",
    directory: null,
    source_experiment: null,
    dataset_hash: ctx.profile.identity.train_sha256 ?? "",
    split_hash: ctx.profile.identity.split_sha256,
    protocol_sha256: ctx.protocol.protocol_sha256,
    status: "completed",
    reason: "ok",
    analysis: {
      summary: "seen",
      findings: [{ statement: "pattern", evidence_refs: ["cell-1"] }],
      methods: [],
      limitations: [],
    },
    cost: {
      status: "known" as const,
      currency_cost: "not_computed" as const,
      attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unknown_attempts: 0,
      elapsed_ms: 0,
    },
    role_usage: {
      planner: {
        status: "known" as const,
        currency_cost: "not_computed" as const,
        attempts: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        unknown_attempts: 0,
        elapsed_ms: 0,
      },
      executor: {
        status: "known" as const,
        currency_cost: "not_computed" as const,
        attempts: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        unknown_attempts: 0,
        elapsed_ms: 0,
      },
    },
    executions: 0,
    source_sha256: "d".repeat(64),
    source_experiments: [],
    request: {
      kind: "analyze" as const,
      question: "why",
      purpose: "explore" as const,
      source_experiments: [],
    },
  };
  ctx.analyses = [analysis];
  expect(bindSource({ source_id: "analysis:a:0" }, ctx).binding).toMatchObject({
    source_experiments: [],
    evidence_refs: ["cell-1"],
  });
  expect(() => bindSource({ source_id: "analysis:a:1" }, ctx)).toThrow();
  for (const alteration of [
    { status: "failed" },
    { dataset_hash: "other" },
    { protocol_sha256: "other" },
  ]) {
    ctx.analyses = [{ ...analysis, ...alteration }];
    expect(() => bindSource({ source_id: "analysis:a:0" }, ctx)).toThrow();
  }
});
