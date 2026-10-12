import { mkdir } from "node:fs/promises";
import { integer, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";
import provenance from "./benchmarks/infiagent-provenance.json";

export const CONCEPTS = [
  "Summary Statistics",
  "Correlation Analysis",
  "Feature Engineering",
  "Data Cleaning",
  "Data Preprocessing",
  "Data Filtering",
  "Data Aggregation",
];
export const EXCLUDED =
  /p[- ]?value|significan|ANOVA|regression|hypothesis|scipy|sklearn|scikit|statsmodels|machine learning|t-test/i;
export function selectDevelopment(values: unknown[]) {
  const rows = values
    .map((v) => {
      const x = obj(v);
      return {
        id: integer(x.id, "id", 0),
        level: str(x.level, "level"),
        file: str(x.file_name, "file_name"),
        concepts: strings(x.concepts, "concepts"),
        text: [x.question, x.constraints, x.format]
          .map((s) => str(s, "question text"))
          .join("\n"),
      };
    })
    .sort((a, b) => a.id - b.id);
  const selected: typeof rows = [],
    used = new Map<string, number>();
  for (const level of ["easy", "medium", "hard"]) {
    let count = 0;
    for (const row of rows) {
      if (
        row.level !== level ||
        !row.concepts.every((c) => CONCEPTS.includes(c)) ||
        EXCLUDED.test(row.text) ||
        (used.get(row.file) ?? 0) >= 2
      )
        continue;
      selected.push(row);
      used.set(row.file, (used.get(row.file) ?? 0) + 1);
      if (++count === 4) break;
    }
    if (count !== 4)
      throw new Error(`Insufficient publicly eligible tasks: ${level}`);
  }
  return selected.map(({ text: _text, ...row }) => row);
}
export async function freezeDevelopment() {
  // Selection reads public metadata only. Private labels are never opened here.
  const bytes = await Bun.file(
    "benchmarks/infiagent-dabench/public/questions.jsonl",
  ).bytes();
  const version = sha256(bytes);
  if (
    version !==
    provenance.resources.find((r) => r.path === "public/questions.jsonl")
      ?.sha256
  )
    throw new Error("Question version mismatch");
  const selected = selectDevelopment(
    Buffer.from(bytes)
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  const manifest = {
    schema_version: 1,
    version: "infi-development-v1",
    purpose: "development",
    question_sha256: version,
    selection: {
      order: "difficulty easy/medium/hard then ascending numeric id",
      per_difficulty: 4,
      maximum_per_csv: 2,
      concepts: CONCEPTS,
      excluded_public_text: EXCLUDED.source,
      reason:
        "Use the existing numpy/pandas image without new statistical-test or training dependencies; independent of answers and scores",
    },
    tasks: selected.map((t) => ({
      ...t,
      input: provenance.resources.find(
        (r) => r.path === `public/tables/${t.file}`,
      ),
    })),
  };
  const smoke = ["easy", "medium", "hard"].map((level) =>
    String(selected.find((t) => t.level === level)?.id),
  );
  const base = {
    schema_version: 1,
    purpose: "development",
    development_overlap:
      "infi-development-v1; selected CSVs are development-exposed; formal experiments must disclose or exclude overlap",
    benchmark: {
      adapter: "infiagent-dabench",
      version,
      options: { root: "benchmarks/infiagent-dabench" },
      task_ids: smoke,
    },
    agents: [
      {
        id: "eda-deepseek-flash",
        adapter: "statigent-eda",
        options: { image: "statigent-runtime:dev" },
        model_profile: "deepseek-flash",
        require_seed: true,
      },
    ],
    repetitions: 1,
    seed: 42,
    task_budget: {
      timeout_ms: 300000,
      model_attempts: 12,
      total_tokens: 100000,
    },
    batch_budget: {
      timeout_ms: 1200000,
      model_attempts: 36,
      total_tokens: 300000,
    },
  };
  await mkdir("configs/evaluations", { recursive: true });
  for (const [name, value] of Object.entries({
    "infiagent-development-selection": manifest,
    "infiagent-smoke": base,
    "infiagent-development": {
      ...base,
      benchmark: {
        ...base.benchmark,
        task_ids: selected.map((t) => String(t.id)),
      },
      batch_budget: {
        timeout_ms: 4800000,
        model_attempts: 144,
        total_tokens: 1200000,
      },
    },
  }))
    await Bun.write(
      `configs/evaluations/${name}.json`,
      `${JSON.stringify(value, null, 2)}\n`,
    );
  return { selected: selected.map((t) => t.id), smoke };
}
if (import.meta.main) console.log(await freezeDevelopment());
