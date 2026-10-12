import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { obj, str, strings } from "../models/validation";
import { createDacomp } from "./benchmarks/dacomp";
import { createDsbenchAnalysis } from "./benchmarks/dsbench";

/** Agent and judge budgets shared by the analysis development configs. */
const AGENT = {
  id: "eda-deepseek-flash",
  adapter: "statigent-eda",
  options: { image: "statigent-runtime:dev" },
  model_profile: "deepseek-flash",
  require_seed: true,
};
// The agent reserves its 65536-token output limit before each request, so thresholds sit well above it.
const TASK_BUDGET = {
  timeout_ms: 600000,
  model_attempts: 12,
  total_tokens: 400000,
};
const batch = (units: number, perUnit: typeof TASK_BUDGET) => ({
  timeout_ms: perUnit.timeout_ms * units,
  model_attempts: perUnit.model_attempts * units,
  total_tokens: perUnit.total_tokens * units,
});
async function write(name: string, value: unknown): Promise<void> {
  await mkdir("configs/evaluations", { recursive: true });
  await Bun.write(
    `configs/evaluations/${name}.json`,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
export interface CaseListing {
  id: string;
  questions: string[];
  files: string[];
}
const TEXT = /^(introduction|question\d+)\.txt$/;
/**
 * DSBench development rule (public information only): cases whose data files are all .xlsx/.csv and
 * that have at least one, no images or notebooks; ascending case id; first 3 cases, first 2 questions.
 */
export function selectDsbench(cases: CaseListing[]) {
  const eligible = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .filter((c) => {
      const data = c.files.filter((f) => !TEXT.test(f));
      return (
        data.length > 0 &&
        data.every((f) => /\.(xlsx|csv)$/i.test(f)) &&
        c.questions.length >= 2
      );
    })
    .slice(0, 3);
  if (eligible.length !== 3)
    throw new Error("Insufficient publicly eligible DSBench cases");
  const tasks = eligible.flatMap((c) =>
    c.questions.slice(0, 2).map((q) => `${c.id}-${q}`),
  );
  return { cases: eligible.map((c) => c.id), tasks, smoke: tasks.slice(0, 2) };
}
export async function freezeDsbench(root = "benchmarks/dsbench") {
  // Reads the public index and file names only; the answer index is never opened here.
  const publicRoot = join(root, "analysis/public");
  const index = (await Bun.file(join(publicRoot, "tasks.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => obj(JSON.parse(line)));
  const cases: CaseListing[] = [];
  for (const row of index) {
    const id = str(row.id, "id");
    cases.push({
      id,
      questions: strings(row.questions, "questions"),
      files: (await readdir(join(publicRoot, id))).sort(),
    });
  }
  const selected = selectDsbench(cases);
  const catalog = await createDsbenchAnalysis().catalog({ root });
  const version = String(catalog.provenance.version);
  const judge = {
    judges: { equivalence: "deepseek-flash-judge" },
    unit_budget: { timeout_ms: 300000, model_attempts: 3, total_tokens: 20000 },
    parse_retries: 2,
    options: {},
  };
  const base = (tasks: string[]) => ({
    schema_version: 2,
    purpose: "development",
    development_overlap:
      "dsbench-analysis-development-v1; selected cases are development-exposed; formal experiments must disclose or exclude them",
    benchmark: {
      adapter: "dsbench-analysis",
      version,
      options: { root },
      task_ids: tasks,
    },
    agents: [AGENT],
    repetitions: 1,
    seed: 42,
    task_budget: TASK_BUDGET,
    batch_budget: batch(tasks.length, TASK_BUDGET),
    scoring: {
      ...judge,
      batch_budget: batch(tasks.length, judge.unit_budget),
    },
  });
  await write("dsbench-analysis-development-selection", {
    schema_version: 1,
    version: "dsbench-analysis-development-v1",
    purpose: "development",
    data_version: version,
    selection: {
      rule: "cases with at least one data file, all data files .xlsx/.csv (no images, notebooks, .xlsb/.xlsm), at least two questions; ascending case id; first 3 cases; first 2 questions of each in index order",
      smoke: "first two selected tasks",
      reason:
        "Exercise workbook reading and the judge path cheaply; independent of answers and scores",
    },
    cases: selected.cases,
    tasks: selected.tasks,
  });
  await write("dsbench-analysis-development", base(selected.tasks));
  await write("dsbench-analysis-smoke", base(selected.smoke));
  return selected;
}
export const DACOMP_MAX_BYTES = 100_000_000;
/**
 * DAComp development rule (public information only): databases of at most 100 MB, ascending task id,
 * 6 tasks at evenly spaced positions floor(i * n / 6); the smoke config takes the first 2.
 */
export function selectDacomp(rows: { id: string; bytes: number }[]) {
  const eligible = rows
    .filter((r) => r.bytes <= DACOMP_MAX_BYTES)
    .map((r) => r.id)
    .sort();
  if (eligible.length < 6)
    throw new Error("Insufficient eligible DAComp tasks");
  const tasks = [0, 1, 2, 3, 4, 5].map(
    (i) => eligible[Math.floor((i * eligible.length) / 6)] ?? "",
  );
  return { eligible: eligible.length, tasks, smoke: tasks.slice(0, 2) };
}
// Report tasks are multi-step; judging sends 11 requests per unit (12 in compatibility mode).
const DACOMP_TASK_BUDGET = {
  timeout_ms: 900000,
  model_attempts: 20,
  total_tokens: 800000,
};
export async function freezeDacomp(root = "benchmarks/dacomp-da") {
  // Reads the public instruction index and database sizes only; evaluator files are not opened.
  const index = (await Bun.file(join(root, "public/dacomp-da.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => str(obj(JSON.parse(line)).instance_id, "instance_id"));
  const rows = await Promise.all(
    index.map(async (id) => ({
      id,
      bytes: Bun.file(join(root, "public", id, `${id}.sqlite`)).size,
    })),
  );
  const selected = selectDacomp(rows);
  const catalog = await createDacomp().catalog({ root });
  const version = String(catalog.provenance.version);
  const judge = {
    judges: {
      rubric: "deepseek-flash-judge",
      gsb_text: "deepseek-flash-judge",
      gsb_vision: "deepseek-flash-judge",
    },
    unit_budget: {
      timeout_ms: 900000,
      model_attempts: 30,
      total_tokens: 400000,
    },
    parse_retries: 2,
    options: { upstream_compatible: false },
  };
  const base = (tasks: string[]) => ({
    schema_version: 2,
    purpose: "development",
    development_overlap:
      "dacomp-da-development-v1; selected tasks are development-exposed; formal experiments must disclose or exclude them",
    benchmark: {
      adapter: "dacomp-da",
      version,
      options: { root, metadata: "benchmarks/metadata" },
      task_ids: tasks,
    },
    agents: [AGENT],
    repetitions: 1,
    seed: 42,
    task_budget: DACOMP_TASK_BUDGET,
    batch_budget: batch(tasks.length, DACOMP_TASK_BUDGET),
    scoring: {
      ...judge,
      batch_budget: batch(tasks.length, judge.unit_budget),
    },
  });
  await write("dacomp-da-development-selection", {
    schema_version: 1,
    version: "dacomp-da-development-v1",
    purpose: "development",
    data_version: version,
    selection: {
      rule: "databases of at most 100,000,000 bytes; ascending task id; positions floor(i * n / 6) for i = 0..5",
      eligible: selected.eligible,
      smoke: "first two selected tasks",
      reason:
        "Keep development runs cheap and avoid multi-GB databases; independent of rubrics, references and scores",
    },
    tasks: selected.tasks,
  });
  await write("dacomp-da-development", base(selected.tasks));
  await write("dacomp-da-smoke", base(selected.smoke));
  return selected;
}
if (import.meta.main) {
  const target = process.argv[2];
  if (target === "dsbench") console.log(await freezeDsbench());
  else if (target === "dacomp") console.log(await freezeDacomp());
  else
    throw new Error(
      "Usage: bun src/evaluation/analysis-development.ts dsbench|dacomp",
    );
}
