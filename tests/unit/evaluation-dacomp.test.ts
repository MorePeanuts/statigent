import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDacomp,
  dacompManifest,
  entriesDigest,
} from "../../src/evaluation/benchmarks/dacomp";
import { describeFile, publishInputs } from "../../src/evaluation/files";
import { buildPlan, validateConfig } from "../../src/evaluation/plan";
import { inspect } from "../../src/evaluation/records";
import { createReport } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { ModelFailure } from "../../src/models/client";
import { fixtureRegistry, submission } from "../helpers/evaluation";
import { png } from "../helpers/images";
import {
  FakeJudge,
  judgeProfile,
  type Outcome,
  textJudge,
} from "../helpers/judge";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const SUITE = "evaluator/upstream/dacomp-da/evaluation_suite";
/** A two-task DAComp tree plus downloader-style manifests in `<root>/metadata`. */
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "dacomp-")));
  roots.push(base);
  const root = join(base, "dacomp-da");
  const write = async (path: string, data: string | Buffer) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), data);
  };
  const ids = ["dacomp-001", "dacomp-002"];
  await write(
    "public/dacomp-da.jsonl",
    ids
      .map((id) =>
        JSON.stringify({ instance_id: id, instruction: `Analyze ${id}.` }),
      )
      .join("\n"),
  );
  for (const id of ids) {
    await write(`public/${id}/${id}.sqlite`, `sqlite ${id}`);
    await write(`${SUITE}/src/${id}/rubric.txt`, "secret-rubric");
    await write(
      `${SUITE}/src/${id}/metadata.json`,
      JSON.stringify({
        Total: 10,
        Completeness: 4,
        Accuracy: 4,
        Conclusiveness: 2,
      }),
    );
    for (let k = 0; k < 5; k++) {
      await write(
        `${SUITE}/src/${id}/gsb_ref_${k}/ref.md`,
        `# Reference ${k}\n![c](c.png)`,
      );
      await write(`${SUITE}/src/${id}/gsb_ref_${k}/c.png`, png(2, 2));
    }
  }
  await write(`${SUITE}/core/prompts.py`, "# upstream");
  const entries = async (prefix: string) => {
    const out: { path: string; bytes: number; sha256: string }[] = [];
    const { readdir } = await import("node:fs/promises");
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) await walk(p);
        else {
          const f = await describeFile(root, p);
          out.push({
            path: `dacomp-da/${p}`,
            bytes: f.bytes,
            sha256: f.sha256,
          });
        }
      }
    };
    await walk(prefix);
    return out;
  };
  const metadata = join(base, "metadata");
  await mkdir(metadata);
  await writeFile(
    join(metadata, "dacomp-data-files.json"),
    JSON.stringify(await entries("public")),
  );
  await writeFile(
    join(metadata, "assets-files.json"),
    JSON.stringify(await entries("evaluator")),
  );
  const m = await dacompManifest(metadata);
  const adapter = createDacomp({
    data_entries_sha256: entriesDigest(m.data),
    evaluator_entries_sha256: entriesDigest(m.evaluator),
  });
  return { root, metadata, adapter, write };
}
test("publishes only the instruction and the task's SQLite; evaluator material stays private", async () => {
  const { root, metadata, adapter, write } = await fixture();
  const options = { root, metadata };
  const catalog = await adapter.catalog(options);
  const [task] = catalog.tasks;
  if (!task) throw new Error("task");
  expect(task.goal).toBe("Analyze dacomp-001.");
  expect(task.inputs.map((i) => i.path)).toEqual([
    "dacomp-001/dacomp-001.sqlite",
  ]);
  expect(task.output).toMatchObject({
    kind: "report",
    report_file: "report.md",
  });
  expect(JSON.stringify(catalog.tasks)).not.toContain("secret-rubric");
  await adapter.preflight(options, catalog.tasks);
  const published = join(root, "..", "published");
  await publishInputs(catalog.source_root, task, published);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(published, { recursive: true })).toEqual([
    "dacomp-001",
    "dacomp-001/dacomp-001.sqlite",
  ]);
  // A changed database (same size) is caught by preflight's full hash.
  await write("public/dacomp-002/dacomp-002.sqlite", "sqlite dacomp-00X");
  await expect(adapter.preflight(options, catalog.tasks)).rejects.toThrow(
    "integrity",
  );
  // A manifest that differs from the pinned version is refused outright.
  await writeFile(join(metadata, "assets-files.json"), "[]");
  await expect(adapter.catalog(options)).rejects.toThrow("pinned");
});
type Mode = "images" | "none";
function setup(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: (unit: string) => Mode,
  trajectory = false,
) {
  const registry = fixtureRegistry(f.root, async (i) => {
    const images = mode(i.unit_id) === "images";
    await writeFile(
      join(i.deliverables_root, "report.md"),
      images ? "# Report\n![Trend](chart.png)" : "# Report without charts",
    );
    if (images)
      await writeFile(join(i.deliverables_root, "chart.png"), png(3, 3));
    if (trajectory)
      await writeFile(join(i.deliverables_root, "trajectory.txt"), "step 1");
    return {
      ...submission(i.unit_id),
      trajectory: trajectory ? "trajectory.txt" : null,
    };
  });
  const agent = registry.getAgent("fixture");
  agent.capabilities = {
    ...agent.capabilities,
    outputs: ["text", "report"],
    trajectory: "unified",
  };
  registry.benchmark(f.adapter);
  return registry;
}
async function config(
  f: Awaited<ReturnType<typeof fixture>>,
  scoring: Record<string, unknown> = {},
) {
  return {
    schema_version: 2,
    purpose: "development",
    development_overlap: "synthetic only",
    benchmark: {
      adapter: "dacomp-da",
      version: String(
        (await f.adapter.catalog({ root: f.root, metadata: f.metadata }))
          .provenance.version,
      ),
      options: { root: f.root, metadata: f.metadata },
      task_ids: ["dacomp-001", "dacomp-002"],
    },
    agents: [{ id: "a", adapter: "fixture", options: {}, require_seed: true }],
    repetitions: 1,
    seed: 1,
    task_budget: { timeout_ms: 5000, model_attempts: null, total_tokens: null },
    batch_budget: {
      timeout_ms: 20000,
      model_attempts: null,
      total_tokens: null,
    },
    scoring: {
      judges: {
        rubric: judgeProfile,
        gsb_text: judgeProfile,
        gsb_vision: judgeProfile,
      },
      unit_budget: {
        timeout_ms: 20000,
        model_attempts: 20,
        total_tokens: 100000,
      },
      batch_budget: {
        timeout_ms: 60000,
        model_attempts: 100,
        total_tokens: 1000000,
      },
      parse_retries: 1,
      ...scoring,
    },
  };
}
const RUBRIC = JSON.stringify({
  items: [
    { criterion_type: "Completeness", score: 2 },
    { criterion_type: "Accuracy", score: 2 },
    { criterion_type: "Conclusiveness", score: 1 },
  ],
  total_score: 5,
});
const GSB = JSON.stringify({
  Readability: { score: 5 },
  "Analytical Depth": { score: 5 },
  "Insight Presentation & Visualization": { score: 5 },
});
function judge(answer: (prompt: string, n: number) => Outcome) {
  const sent: string[] = [];
  return {
    sent,
    factory: (p: typeof judgeProfile) =>
      new FakeJudge(p, (body) => {
        const prompt = JSON.stringify(body.messages);
        sent.push(prompt);
        return answer(prompt, sent.length - 1);
      }),
  };
}
const isRubric = (prompt: string) => prompt.includes("secret-rubric");
test("report units are judged by rubric, 5 text and 5 vision comparisons; no images skips vision", async () => {
  const f = await fixture();
  const registry = setup(f, (u) => (u === "unit-000001" ? "images" : "none"));
  const j = judge((prompt) => (isRubric(prompt) ? RUBRIC : GSB));
  const result = await runEvaluation(
    await buildPlan(await config(f), registry),
    registry,
    join(f.root, "..", "runs"),
    {
      environment: {},
      judgeFactory: j.factory,
    },
  );
  const view = await inspect(result.directory);
  const [withImages, without] = view.records;
  expect(withImages?.score?.judge?.attempts).toBe(11);
  expect(without?.score?.judge?.attempts).toBe(6);
  const metric = (r: typeof withImages, name: string) =>
    r?.score?.metrics.find((m) => m.name === name)?.value;
  expect(metric(withImages, "total")).toBeCloseTo(
    100 * (0.6 * 0.5 + 0.1 + 0.1 + 0.2),
  );
  expect(metric(withImages, "visualization")).toBe(1);
  expect(metric(without, "visualization")).toBe(0);
  expect(metric(without, "total")).toBeCloseTo(100 * (0.6 * 0.5 + 0.1 + 0.1));
  expect(metric(withImages, "completeness")).toBe(50);
  expect(withImages?.score?.metrics.map((m) => m.name)).toHaveLength(8);
  // Vision comparisons carry the candidate chart and the reference charts as images.
  const vision = j.sent.filter((p) => p.includes("被评测报告图片附件"));
  expect(vision).toHaveLength(5);
  expect(
    vision.every((p) => (p.match(/data:image\/png/g) ?? []).length === 2),
  ).toBe(true);
  // The primary rubric judges the report, never a trajectory.
  expect(j.sent.filter(isRubric).every((p) => p.includes("# Report"))).toBe(
    true,
  );
});
test("a comparison that stays unparseable fails the unit; judge budget exhaustion leaves units unscored", async () => {
  const f = await fixture();
  const registry = setup(f, () => "images");
  const flaky = judge((prompt) =>
    isRubric(prompt)
      ? RUBRIC
      : prompt.includes("Reference 3") && !prompt.includes("被评测报告图片附件")
        ? "not json"
        : GSB,
  );
  let result = await runEvaluation(
    await buildPlan(await config(f), registry),
    registry,
    join(f.root, "..", "a"),
    {
      environment: {},
      judgeFactory: flaky.factory,
    },
  );
  let view = await inspect(result.directory);
  expect(view.records.map((r) => r.scoring_status)).toEqual([
    "failed",
    "failed",
  ]);
  expect(view.records[0]?.score?.error).toContain("gsb_text:gsb_ref_3");
  const tight = await config(f, {
    batch_budget: {
      timeout_ms: 60000,
      model_attempts: 11,
      total_tokens: 1000000,
    },
  });
  result = await runEvaluation(
    await buildPlan(tight, registry),
    registry,
    join(f.root, "..", "b"),
    {
      environment: {},
      judgeFactory: judge((p) => (isRubric(p) ? RUBRIC : GSB)).factory,
    },
  );
  view = await inspect(result.directory);
  expect(view.records.map((r) => r.scoring_status)).toEqual([
    "scored",
    "not_scored",
  ]);
  const failing = await runEvaluation(
    await buildPlan(await config(f), registry),
    registry,
    join(f.root, "..", "c"),
    {
      environment: {},
      judgeFactory: judge(() => new ModelFailure("http_400", "not_generated"))
        .factory,
    },
  );
  expect(
    (await inspect(failing.directory)).records.every(
      (r) => r.scoring_status === "failed",
    ),
  ).toBe(true);
});
test("vision judging requires a vision-capable profile before any unit runs", async () => {
  const f = await fixture();
  const registry = setup(f, () => "images");
  const c = await config(f);
  c.scoring.judges = {
    rubric: textJudge,
    gsb_text: textJudge,
    gsb_vision: textJudge,
  };
  expect(() => validateConfig(c, registry)).toThrow(
    "gsb_vision requires vision",
  );
});
test("upstream-compatible mode adds a trajectory rubric reported separately from the primary score", async () => {
  const f = await fixture();
  const registry = setup(f, () => "images", true);
  const j = judge((prompt) =>
    isRubric(prompt)
      ? prompt.includes("step 1")
        ? JSON.stringify({ total_score: 10 })
        : RUBRIC
      : GSB,
  );
  const c = await config(f, { options: { upstream_compatible: true } });
  const result = await runEvaluation(
    await buildPlan(c, registry),
    registry,
    join(f.root, "..", "runs"),
    {
      environment: {},
      judgeFactory: j.factory,
    },
  );
  const view = await inspect(result.directory);
  expect(view.records[0]?.score?.judge?.attempts).toBe(12);
  expect(view.records[0]?.score?.details.compat).toEqual({
    total: 100,
    rubric_ratio: 1,
  });
  const report = await createReport(
    result.directory,
    registry,
    undefined,
    result.score_id,
  );
  const group = report.report.groups[0] as Record<string, unknown>;
  expect((group.metrics as Record<string, number>).total).toBeCloseTo(70);
  expect(group.upstream_compatible).toMatchObject({
    enabled: true,
    protocol: "dacomp-da-upstream-trajectory-v1",
    total: 100,
    rubric_ratio: 1,
  });
  // Agents without a unified trajectory cannot be planned in this mode.
  registry.getAgent("fixture").capabilities.trajectory = "none";
  expect(() => validateConfig(c, registry)).toThrow("unified trajectory");
});
test("documented DAComp and DSBench metrics and protocols match the adapters", async () => {
  const doc = await Bun.file("docs/evaluation.md").text();
  const dacomp = doc.slice(
    doc.indexOf("## DAComp-DA 评分"),
    doc.indexOf("## DSBench-Analysis 评分"),
  );
  for (const term of [
    "dacomp-da-report-v1",
    "dacomp-da-upstream-trajectory-v1",
    "total",
    "rubric_ratio",
    "completeness",
    "accuracy",
    "conclusiveness",
    "readability",
    "professionalism",
    "visualization",
    "0.6 × rubric",
  ])
    expect(dacomp).toContain(term);
  const dsbench = doc.slice(doc.indexOf("## DSBench-Analysis 评分"));
  for (const term of ["dsbench-analysis-judge-v1", "accuracy", "case_accuracy"])
    expect(dsbench).toContain(term);
  const f = await fixture();
  const catalog = await f.adapter.catalog({
    root: f.root,
    metadata: f.metadata,
  });
  expect(catalog.provenance).toMatchObject({
    protocol: "dacomp-da-report-v1",
    compat_protocol: "dacomp-da-upstream-trajectory-v1",
    weights: {
      rubric: 0.6,
      readability: 0.1,
      professionalism: 0.1,
      visualization: 0.2,
    },
  });
});
