import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDsbenchAnalysis } from "../../src/evaluation/benchmarks/dsbench";
import { describeFile } from "../../src/evaluation/files";
import { buildPlan } from "../../src/evaluation/plan";
import { inspect } from "../../src/evaluation/records";
import { createReport } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { ModelFailure } from "../../src/models/client";
import { fixtureRegistry, submission } from "../helpers/evaluation";
import { FakeJudge, judgeProfile } from "../helpers/judge";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const PINNED = [
  "analysis/public/tasks.jsonl",
  "analysis/private/tasks-with-answers.jsonl",
  "upstream/data_analysis/data.json",
  "upstream/data_analysis/compute_answer.py",
  "upstream/data_analysis/show_result.py",
  "upstream/LICENSE",
];
async function fixture(answers: unknown[][] = [["B", 7], [{ k: 1 }]]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsbench-")));
  roots.push(root);
  const write = async (path: string, data: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), data);
  };
  const index = [
    { id: "00000001", name: "a", questions: ["question1", "question2"] },
    { id: "00000002", name: "b", questions: ["question1"] },
  ];
  await write(
    "analysis/public/tasks.jsonl",
    index.map((r) => JSON.stringify(r)).join("\n"),
  );
  await write(
    "analysis/private/tasks-with-answers.jsonl",
    index
      .map((r, i) => JSON.stringify({ ...r, answers: answers[i] }))
      .join("\n"),
  );
  await write("analysis/public/00000001/introduction.txt", "Case A intro.");
  await write("analysis/public/00000001/question1.txt", "Which option? A or B");
  await write("analysis/public/00000001/question2.txt", "How many?");
  await write("analysis/public/00000001/book.xlsx", "fake workbook");
  await write("analysis/public/00000001/solution.ipynb", '{"answer": "B"}');
  await write("analysis/public/00000002/introduction.txt", "Case B theory.");
  await write("analysis/public/00000002/question1.txt", "Define k.");
  for (const path of PINNED.slice(2)) await write(path, `upstream ${path}`);
  const resources = await Promise.all(
    PINNED.map(async (path) => {
      const f = await describeFile(root, path);
      return { path, bytes: f.bytes, sha256: f.sha256 };
    }),
  );
  return { root, adapter: createDsbenchAnalysis(resources) };
}
test("one task per question, grouped by case, without answers or notebooks", async () => {
  const { root, adapter } = await fixture();
  const catalog = await adapter.catalog({ root });
  expect(catalog.tasks.map((t) => t.id)).toEqual([
    "00000001-question1",
    "00000001-question2",
    "00000002-question1",
  ]);
  expect(catalog.groups).toEqual({
    "00000001-question1": "00000001",
    "00000001-question2": "00000001",
    "00000002-question1": "00000002",
  });
  const [first, , theory] = catalog.tasks;
  expect(first?.goal).toBe("Case A intro.\n\nQuestion:\nWhich option? A or B");
  expect(first?.inputs.map((i) => i.path)).toEqual(["00000001/book.xlsx"]);
  expect(theory?.inputs).toEqual([]);
  expect(catalog.provenance.excluded).toEqual([
    {
      path: "00000001/solution.ipynb",
      reason: "notebook shipped with the case may contain a reference solution",
    },
  ]);
  const visible = JSON.stringify(catalog.tasks);
  expect(visible).not.toContain("solution.ipynb");
  expect(visible).not.toContain('"answers"');
  await adapter.preflight({ root }, catalog.tasks);
  await writeFile(join(root, "analysis/public/00000001/book.xlsx"), "changed");
  const changed = await adapter.catalog({ root });
  expect(changed.provenance.version).not.toBe(catalog.provenance.version);
});
test("answers must align with questions and exist for every selected task", async () => {
  const misaligned = await fixture([["B"], [{ k: 1 }]]);
  const tasks = (await misaligned.adapter.catalog({ root: misaligned.root }))
    .tasks;
  await expect(
    misaligned.adapter.preflight({ root: misaligned.root }, tasks),
  ).rejects.toThrow("align");
  const invalid = await fixture([["B", true], [{ k: 1 }]]);
  await expect(
    invalid.adapter.preflight(
      { root: invalid.root },
      (await invalid.adapter.catalog({ root: invalid.root })).tasks,
    ),
  ).rejects.toThrow("Invalid reference answer");
});
function registry(
  root: string,
  adapter: ReturnType<typeof createDsbenchAnalysis>,
) {
  const r = fixtureRegistry(root, async (i) => ({
    ...submission(i.unit_id),
    status: i.task.id === "00000001-question2" ? "failed" : "completed",
    answer_text: i.task.id === "00000001-question2" ? "" : "B",
  }));
  r.benchmark(adapter);
  return r;
}
function config(scoring = {}) {
  return {
    schema_version: 2,
    purpose: "development",
    development_overlap: "synthetic only",
    benchmark: {
      adapter: "dsbench-analysis",
      version: "",
      options: {},
      task_ids: [
        "00000001-question1",
        "00000001-question2",
        "00000002-question1",
      ],
    },
    agents: [{ id: "a", adapter: "fixture", options: {}, require_seed: true }],
    repetitions: 1,
    seed: 1,
    task_budget: { timeout_ms: 1000, model_attempts: null, total_tokens: null },
    batch_budget: {
      timeout_ms: 10000,
      model_attempts: null,
      total_tokens: null,
    },
    scoring: {
      judges: { equivalence: judgeProfile },
      unit_budget: { timeout_ms: 10000, model_attempts: 3, total_tokens: 1000 },
      batch_budget: {
        timeout_ms: 10000,
        model_attempts: 10,
        total_tokens: 1000,
      },
      parse_retries: 0,
      ...scoring,
    },
  };
}
test("judged accuracy and case accuracy; unanswered units are wrong without a judge call", async () => {
  const { root, adapter } = await fixture();
  const r = registry(root, adapter);
  const c = config();
  c.benchmark.options = { root };
  c.benchmark.version = String(
    (await adapter.catalog({ root })).provenance.version,
  );
  const prompts: string[] = [];
  const result = await runEvaluation(
    await buildPlan(c, r),
    r,
    join(root, "runs"),
    {
      environment: {},
      judgeFactory: (p) =>
        new FakeJudge(p, (body) => {
          const prompt = JSON.stringify(body.messages);
          prompts.push(prompt);
          return prompt.includes("Which option") ? "True" : "Flase";
        }),
    },
  );
  const view = await inspect(result.directory);
  expect(view.records.map((x) => x.score?.metrics[0]?.value)).toEqual([
    1, 0, 0,
  ]);
  expect(view.records.map((x) => x.score?.judge?.attempts)).toEqual([1, 0, 1]);
  expect(prompts).toHaveLength(2);
  // The reference is formatted like upstream's Python str(), dicts included.
  expect(prompts[1]).toContain("The true answer is \\n {'k': 1}");
  expect(prompts[0]).toContain("The question is Which option? A or B.");
  expect(prompts.join()).not.toContain("Case A intro");
  const report = await createReport(
    result.directory,
    r,
    undefined,
    result.score_id,
  );
  const group = report.report.groups[0] as { metrics: object; grouped: object };
  expect(group.metrics).toMatchObject({ accuracy: 1 / 3 });
  expect(group.grouped).toEqual({ case_accuracy: (0.5 + 0) / 2 });
});
test("judge failures are scoring errors, not wrong answers", async () => {
  const { root, adapter } = await fixture();
  const r = registry(root, adapter);
  const c = config();
  c.benchmark.options = { root };
  c.benchmark.version = String(
    (await adapter.catalog({ root })).provenance.version,
  );
  const result = await runEvaluation(
    await buildPlan(c, r),
    r,
    join(root, "runs"),
    {
      environment: {},
      judgeFactory: (p) =>
        new FakeJudge(p, () => new ModelFailure("http_400", "not_generated")),
    },
  );
  const view = await inspect(result.directory);
  expect(view.records.map((x) => x.scoring_status)).toEqual([
    "failed",
    "scored",
    "failed",
  ]);
  expect(view.records[0]?.score?.error).toContain("http_400");
  const report = await createReport(
    result.directory,
    r,
    undefined,
    result.score_id,
  );
  expect(report.report.groups[0]).toMatchObject({
    status: "incomplete",
    grouped: { case_accuracy: null },
  });
});
