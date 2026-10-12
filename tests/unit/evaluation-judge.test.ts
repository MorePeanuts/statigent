import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../../src/evaluation/aggregate";
import { JudgeBudgetExhausted, JudgeSession } from "../../src/evaluation/judge";
import { buildPlan, validateConfig } from "../../src/evaluation/plan";
import { inspect, type UnitRecord } from "../../src/evaluation/records";
import { createReport, rescore } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { ModelFailure } from "../../src/models/client";
import { config, fixtureRegistry } from "../helpers/evaluation";
import { png } from "../helpers/images";
import {
  FakeJudge,
  judgedConfig,
  judgedRegistry,
  judgeProfile,
  type Outcome,
  textJudge,
} from "../helpers/judge";

const roots: string[] = [];
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "judge-test-")));
  roots.push(root);
  await writeFile(join(root, "data.csv"), "value\n1\n2\n");
  return { root, registry: judgedRegistry(root) };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function fakes(next: (body: Record<string, unknown>, n: number) => Outcome) {
  const created: FakeJudge[] = [];
  let n = 0;
  return {
    created,
    factory: (profile: typeof judgeProfile) => {
      const f = new FakeJudge(profile, (body) => next(body, n++));
      created.push(f);
      return f;
    },
    bodies: () => created.flatMap((c) => c.bodies),
  };
}
test("judge roles, capabilities and profiles are checked before any unit runs", async () => {
  const { root, registry } = await setup();
  expect(validateConfig(judgedConfig(), registry).scoring?.parse_retries).toBe(
    1,
  );
  const cases: [Record<string, unknown>, string][] = [
    [{ judges: { text: judgeProfile } }, "Missing judge role mapping: vision"],
    [
      { judges: { text: judgeProfile, vision: textJudge } },
      "requires vision capability",
    ],
    [{ judges: { text: "nope", vision: "nope" } }, "Unknown model profile"],
    [
      {
        judges: {
          text: judgeProfile,
          vision: judgeProfile,
          extra: judgeProfile,
        },
      },
      "Unknown judge role",
    ],
    [{ cross_agent_summary: true }, "not implemented"],
    [
      { unit_budget: { timeout_ms: 1, model_attempts: null, total_tokens: 1 } },
      "attempts",
    ],
  ];
  for (const [scoring, message] of cases)
    expect(() => validateConfig(judgedConfig(scoring), registry, [])).toThrow(
      message,
    );
  const { scoring: _s, ...unjudged } = judgedConfig();
  expect(() => validateConfig(unjudged, registry)).toThrow(
    "requires scoring config",
  );
  // Missing credentials stop the batch before the agent is called or a batch directory exists.
  let agentCalls = 0;
  const agent = registry.getAgent("fixture");
  const run = agent.run;
  agent.run = async (i, s) => {
    agentCalls++;
    return run(i, s);
  };
  const plan = await buildPlan(judgedConfig(), registry);
  await expect(
    runEvaluation(plan, registry, join(root, "runs"), { environment: {} }),
  ).rejects.toThrow("JUDGE_TEST_KEY");
  expect(agentCalls).toBe(0);
  expect(await Bun.file(join(root, "runs")).exists()).toBe(false);
});
test("judge attempts are bounded, charged and logged by hash only", async () => {
  const { root } = await setup();
  const scoring = validateConfig(judgedConfig(), judgedRegistry(root)).scoring;
  if (!scoring) throw new Error("scoring");
  let n = 0;
  const outcomes: Outcome[] = [
    "garbage",
    "still garbage",
    new ModelFailure("rate_limited", "not_generated", true),
    "score:1",
  ];
  const slept: number[] = [];
  const session = new JudgeSession(
    scoring,
    join(root, "judge"),
    [],
    (p) => new FakeJudge(p, () => outcomes[n++] ?? "score:1"),
    {
      request_timeout_ms: 1000,
      max_request_bytes: 1 << 20,
      max_response_bytes: 1 << 20,
      rate_retries: 2,
      backoff_ms: 5,
      recorded_response_bytes: 4,
    },
    async (ms) => {
      slept.push(ms);
    },
  );
  const unit = session.forUnit("unit-000001");
  const parse = (r: string) => {
    if (!r.startsWith("score:")) throw new Error("bad");
    return Number(r.slice(6));
  };
  await expect(
    unit.ask("text", [{ type: "text", text: "rubric-secret" }], "t", parse),
  ).rejects.toThrow("unparseable after retries");
  expect(unit.ledger).toMatchObject({ attempts: 2, input_tokens: 20 });
  // A rate-limit rejection is retried with backoff and costs no attempt.
  expect(
    await unit.ask("text", [{ type: "text", text: "x" }], "t2", parse),
  ).toBe(1);
  expect(slept).toEqual([5]);
  expect(unit.summary()).toMatchObject({
    attempts: 3,
    total_tokens: 45,
    models: ["judge-model-2026"],
    fingerprints: ["fp"],
    self_preference_risk: false,
  });
  const log = await readFile(join(root, "judge", "unit-000001.jsonl"), "utf8");
  expect(log).not.toContain("rubric-secret");
  expect(log).toContain("text_sha256");
  expect(log.split("\n").filter((l) => l.includes("parse_error"))).toHaveLength(
    2,
  );
  expect(log).toContain('"response":"garb"');
  // Unit budgets stop further requests for that unit only.
  const tight = new JudgeSession(
    { ...scoring, unit_budget: { ...scoring.unit_budget, model_attempts: 1 } },
    join(root, "judge2"),
    ["judge-model"],
    (p) => new FakeJudge(p, () => "score:1"),
  );
  const u = tight.forUnit("unit-000001");
  await u.ask("text", [{ type: "text", text: "x" }], "a", parse);
  await expect(
    u.ask("text", [{ type: "text", text: "x" }], "b", parse),
  ).rejects.toBeInstanceOf(JudgeBudgetExhausted);
  expect(tight.exhausted).toBe("");
  expect(u.summary().self_preference_risk).toBe(true);
  // Unknown usage is charged and stops every later judge request.
  const unknown = new JudgeSession(
    scoring,
    join(root, "judge3"),
    [],
    (p) => new FakeJudge(p, () => new ModelFailure("http_500", "unknown")),
  );
  const v = unknown.forUnit("unit-000001");
  await expect(
    v.ask("text", [{ type: "text", text: "x" }], "c", parse),
  ).rejects.toThrow("http_500");
  expect(v.summary()).toMatchObject({ attempts: 1, unknown_attempts: 1 });
  expect(unknown.exhausted).toBe("unknown_judge_usage");
});
test("runner judges frozen units, separates judge usage and skips vision when no image exists", async () => {
  const { root, registry } = await setup();
  const judge = fakes(() => "score:1");
  const plan = await buildPlan(judgedConfig(), registry);
  const result = await runEvaluation(plan, registry, join(root, "runs"), {
    environment: {},
    judgeFactory: judge.factory,
  });
  const view = await inspect(result.directory);
  expect(view.records.map((r) => r.score?.metrics[0]?.value)).toEqual([1, 0.5]);
  expect(view.records.map((r) => r.score?.judge?.attempts)).toEqual([2, 1]);
  const images = judge
    .bodies()
    .flatMap((b) => JSON.stringify(b).match(/data:image\/png/g) ?? []);
  expect(images).toHaveLength(1);
  const report = await createReport(
    result.directory,
    registry,
    undefined,
    result.score_id,
  );
  expect(
    await Bun.file(
      join(
        result.directory,
        "scores",
        result.score_id,
        "judge/unit-000001.jsonl",
      ),
    ).exists(),
  ).toBe(true);
  const group = report.report.groups[0] as Record<string, unknown>;
  expect(group.usage).toMatchObject({ total_tokens: 0 });
  expect(group.judge_usage).toMatchObject({
    attempts: 3,
    total_tokens: 45,
    nondeterministic: true,
    self_preference_risk: false,
  });
  expect(group.grouped).toEqual({ group_score: 0.75 });
  const csv = await readFile(join(report.directory, "units.csv"), "utf8");
  for (const column of [
    "judge_attempts",
    "judge_protocol",
    "self_preference_risk",
  ])
    expect(csv).toContain(column);
});
test("judge failures are scoring errors and exhausted budgets leave units not scored", async () => {
  const { root, registry } = await setup();
  const timeout = fakes(() => new ModelFailure("request_aborted", "unknown"));
  let plan = await buildPlan(judgedConfig(), registry);
  let result = await runEvaluation(plan, registry, join(root, "a"), {
    environment: {},
    judgeFactory: timeout.factory,
  });
  let view = await inspect(result.directory);
  expect(view.records.map((r) => r.execution_status)).toEqual([
    "completed",
    "completed",
  ]);
  expect(view.records.map((r) => r.scoring_status)).toEqual([
    "failed",
    "not_scored",
  ]);
  expect(view.records[0]?.score?.error).toContain("request_aborted");
  expect(view.records[1]?.scoring_reason).toBe("unknown_judge_usage");
  plan = await buildPlan(
    judgedConfig({
      batch_budget: {
        timeout_ms: 10000,
        model_attempts: 2,
        total_tokens: 10000,
      },
    }),
    registry,
  );
  result = await runEvaluation(plan, registry, join(root, "b"), {
    environment: {},
    judgeFactory: fakes(() => "score:1").factory,
  });
  view = await inspect(result.directory);
  expect(view.records.map((r) => r.scoring_status)).toEqual([
    "scored",
    "not_scored",
  ]);
  expect(view.records[1]?.scoring_reason).toBe("judge_budget_exhausted");
  const summary = aggregate(view.records, plan.groups, [
    { name: "g", metric: "score", within: "mean", across: "mean" },
  ]);
  expect(summary).toMatchObject({
    status: "incomplete",
    not_scored: 1,
    metrics: { score: null },
    grouped: { g: null },
  });
  expect(view.manifest.status).toBe("incomplete");
});
test("grouped summaries average within and then across groups", () => {
  const record = (task: string, value: number, i: number): UnitRecord => ({
    unit: { id: `u${i}`, task_id: task, agent_id: "a", repetition: 0, seed: 1 },
    execution_status: "completed",
    reason: "",
    started_at: "now",
    ended_at: "now",
    elapsed_ms: 1,
    effective_budget: null,
    budget_status: "within",
    submission_sha256: null,
    scoring_status: "scored",
    score: {
      schema_version: 2,
      unit_id: `u${i}`,
      protocol: "p",
      status: "scored",
      metrics: [
        {
          name: "accuracy",
          value,
          minimum: 0,
          maximum: 1,
          direction: "higher",
        },
      ],
      details: {},
      error: null,
      judge: null,
    },
  });
  const values = [1, 1, 0, 1, 0, 0, 0, 0, 0, 0];
  const tasks = values.map((_, i) => `q${i}`);
  const groups = Object.fromEntries(
    tasks.map((t, i) => [t, i < 3 ? "case-a" : "case-b"]),
  );
  const records = values.map((v, i) => record(tasks[i] ?? "", v, i));
  const summaries = [
    {
      name: "case_accuracy",
      metric: "accuracy",
      within: "mean",
      across: "mean",
    } as const,
  ];
  const result = aggregate(records, groups, summaries);
  expect(result.metrics.accuracy).toBeCloseTo(0.3);
  expect(result.grouped.case_accuracy).toBeCloseTo((2 / 3 + 1 / 7) / 2);
  expect(result.grouped.case_accuracy).toBeCloseTo(0.4048, 4);
  const broken = records.map((r, i) =>
    i === 4
      ? {
          ...r,
          scoring_status: "failed" as const,
          score: {
            ...(r.score as NonNullable<UnitRecord["score"]>),
            status: "failed" as const,
            metrics: [],
            error: "judge",
          },
        }
      : r,
  );
  expect(aggregate(broken, groups, summaries).grouped.case_accuracy).toBeNull();
  expect(() => aggregate(records, {}, summaries)).toThrow("Missing group");
});
test("judged rescoring requires explicit permission and budget; deterministic rescoring is unchanged", async () => {
  const { root, registry } = await setup();
  const plan = await buildPlan(judgedConfig(), registry);
  const first = fakes(() => "score:1");
  const result = await runEvaluation(plan, registry, join(root, "runs"), {
    environment: {},
    judgeFactory: first.factory,
  });
  await createReport(result.directory, registry, undefined, result.score_id);
  const refused = fakes(() => "score:0");
  for (const options of [
    {},
    { allowModelCalls: true },
    {
      judgeBudget: {
        unit_budget: {
          timeout_ms: 1000,
          model_attempts: 5,
          total_tokens: 1000,
        },
        batch_budget: {
          timeout_ms: 1000,
          model_attempts: 5,
          total_tokens: 1000,
        },
      },
    },
  ])
    await expect(
      rescore(result.directory, registry, {
        ...options,
        judgeFactory: refused.factory,
      }),
    ).rejects.toThrow("--allow-model-calls");
  expect(refused.bodies()).toHaveLength(0);
  const again = fakes(() => "score:0");
  const second = await rescore(result.directory, registry, {
    allowModelCalls: true,
    judgeBudget: {
      unit_budget: { timeout_ms: 10000, model_attempts: 5, total_tokens: 1000 },
      batch_budget: {
        timeout_ms: 10000,
        model_attempts: 5,
        total_tokens: 1000,
      },
    },
    judgeFactory: again.factory,
  });
  expect(second.score_id).not.toBe(result.score_id);
  expect(second.report.scores.map((s) => s.score?.metrics[0]?.value)).toEqual([
    0, 0,
  ]);
  const original = await inspect(result.directory);
  expect(original.records.map((r) => r.score?.metrics[0]?.value)).toEqual([
    1, 0.5,
  ]);
  // Deterministic protocols still rescore offline without any flag.
  const plain = fixtureRegistry(root);
  const det = await runEvaluation(
    await buildPlan(config(), plain),
    plain,
    join(root, "det"),
    { environment: {} },
  );
  expect((await rescore(det.directory, plain)).report.rescored).toBe(true);
});
test("judge image parts reject non-image deliverables before sending", async () => {
  const { root } = await setup();
  const scoring = validateConfig(judgedConfig(), judgedRegistry(root)).scoring;
  if (!scoring) throw new Error("scoring");
  const sent: unknown[] = [];
  const session = new JudgeSession(
    scoring,
    join(root, "j"),
    [],
    (p) =>
      new FakeJudge(p, (b) => {
        sent.push(b);
        return "score:1";
      }),
  );
  await writeFile(join(root, "fake.png"), "not a png");
  await writeFile(join(root, "real.png"), png(3, 3));
  const unit = session.forUnit("unit-000001");
  await expect(
    unit.ask(
      "vision",
      [{ type: "image", path: join(root, "fake.png") }],
      "v",
      () => 1,
    ),
  ).rejects.toThrow("image_format_rejected");
  expect(sent).toHaveLength(0);
  expect(unit.ledger.attempts).toBe(0);
  expect(
    await unit.ask(
      "vision",
      [{ type: "image", path: join(root, "real.png") }],
      "v",
      () => 1,
    ),
  ).toBe(1);
});
test("documented scoring config and report fields match the implementation", async () => {
  const doc = await Bun.file("docs/evaluation.md").text();
  const section = doc.slice(doc.indexOf("## 评委评分"));
  const block = /```json\n([\s\S]*?)```/.exec(section)?.[1];
  if (!block) throw new Error("Missing documented scoring config");
  const documented = JSON.parse(block).scoring;
  const { root, registry } = await setup();
  const models = await Bun.file("configs/models.json").json();
  // Map the documented budgets onto the synthetic protocol's two roles.
  const parsed = validateConfig(
    judgedConfig({
      ...documented,
      judges: { text: "deepseek-flash-judge", vision: "deepseek-flash-judge" },
    }),
    registry,
    models,
  );
  expect(parsed.scoring?.batch_budget.total_tokens).toBe(1600000);
  const result = await runEvaluation(
    await buildPlan(judgedConfig(), registry),
    registry,
    join(root, "runs"),
    { environment: {}, judgeFactory: fakes(() => "score:1").factory },
  );
  const report = await createReport(
    result.directory,
    registry,
    undefined,
    result.score_id,
  );
  const group = report.report.groups[0] as Record<string, unknown>;
  // Every judge_usage field has a documented meaning.
  const documentedTerms: Record<string, string> = {
    attempts: "尝试次数",
    input_tokens: "token",
    output_tokens: "token",
    total_tokens: "token",
    unknown_attempts: "未知请求",
    elapsed_ms: "耗时",
    self_preference_risk: "self_preference_risk",
    judges: "角色到 profile/模型的映射",
    nondeterministic: "nondeterministic",
    currency_cost: "not_computed",
  };
  for (const key of Object.keys(group.judge_usage as object)) {
    const term = documentedTerms[key];
    if (!term) throw new Error(`Undocumented judge_usage field: ${key}`);
    expect(section).toContain(term);
  }
  for (const column of [
    "judge_protocol",
    "judge_attempts",
    "judge_total_tokens",
    "judge_unknown_attempts",
    "self_preference_risk",
  ])
    expect(Object.keys(report.report.rows[0] ?? {})).toContain(column);
});
