import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Analysis } from "../agent/actions";
import { DEFAULT_BUDGET } from "../agent/config";
import { type RunOptions, runAgent } from "../agent/run";
import type { ModelClient } from "../models/client";
import type { ModelProfile } from "../models/config";
import { readManifest } from "../records/store";
import type { EvidenceUse, ModelingAction } from "./actions";
import { ledger } from "./budget";
import type { ModelingTask } from "./config";
import { csv, type Dataset, parseCsv, select, type Table } from "./data";
import { type Experiment, predictionValues, stageBytes } from "./experiments";
export interface AnalysisRecord {
  id: string;
  source_experiment: string | null;
  dataset_hash: string;
  split_hash: string;
  status: string;
  reason: string;
  analysis: Analysis | null;
  run_id: string;
  directory: string;
  cost: ReturnType<typeof ledger>;
  role_usage: {
    planner: ReturnType<typeof ledger>;
    executor: ReturnType<typeof ledger>;
  };
  executions: number;
  request: Extract<ModelingAction, { kind: "analyze" }>;
}
export async function prepareAnalysisInput(
  root: string,
  dataset: Dataset,
  train: Table,
  experiment: Experiment | null,
) {
  await mkdir(root, { recursive: false });
  await writeFile(join(root, "train.csv"), csv(train), {
    flag: "wx",
    mode: 0o444,
  });
  await writeFile(join(root, "split.json"), JSON.stringify(dataset.split), {
    flag: "wx",
    mode: 0o444,
  });
  const inputs = ["train.csv", "split.json"];
  if (experiment) {
    if (
      experiment.status !== "completed" ||
      !experiment.predict ||
      experiment.final
    )
      throw new Error("Invalid analysis experiment");
    const values = predictionValues(
      parseCsv((await stageBytes(experiment.predict)).toString()),
      dataset.split.validation,
      dataset.id_column,
    );
    const table = select(train, dataset.split.validation, dataset.id_column);
    let prediction = "__prediction";
    while (table.columns.includes(prediction)) prediction += "_";
    const errors = {
      columns: [...table.columns, prediction],
      rows: table.rows.map((r, i) => [...r, String(values[i])]),
    };
    await writeFile(join(root, "validation.csv"), csv(errors), {
      flag: "wx",
      mode: 0o444,
    });
    inputs.push("validation.csv");
  }
  await writeFile(
    join(root, "source.json"),
    JSON.stringify({
      experiment_id: experiment?.id ?? null,
      target: dataset.target,
      id_column: dataset.id_column,
      data: dataset.files[0],
      split_sha256: dataset.split.sha256,
    }),
    { flag: "wx", mode: 0o444 },
  );
  inputs.push("source.json");
  return inputs;
}
export async function analyze(o: {
  id: string;
  runId: string;
  root: string;
  task: ModelingTask;
  dataset: Dataset;
  train: Table;
  experiment: Experiment | null;
  request: Extract<ModelingAction, { kind: "analyze" }>;
  profile: ModelProfile;
  signal: AbortSignal;
  budget: {
    model_attempts: number;
    total_tokens: number;
    executions: number;
    task_timeout_ms: number;
  };
  client?: ModelClient;
  run?: typeof runAgent;
}): Promise<AnalysisRecord> {
  const input = join(o.root, `${o.id}-input`),
    inputs = await prepareAnalysisInput(
      input,
      o.dataset,
      o.train,
      o.experiment,
    );
  const b = o.task.budget;
  const options: RunOptions = {
    runId: o.runId,
    runRoot: join(o.root, "eda"),
    profile: o.profile,
    signal: o.signal,
    client: o.client,
    task: {
      organization: "planner-executor",
      goal: JSON.stringify(o.request),
      constraints: [
        "Only investigate the current candidate uncertainty. This is internal validation, never external test evaluation.",
        "Return concise evidence and methods. Do not write a Markdown report or train candidate models. source.json identifies data, target and prediction provenance.",
      ],
      model_profile: o.profile.id,
      execution: {
        image: o.task.image,
        input_root: input,
        inputs,
        seed: o.dataset.seed,
        limits: o.task.limits,
      },
      budget: {
        ...DEFAULT_BUDGET,
        ...o.budget,
        code_repairs: b.code_repairs,
        action_corrections: b.action_corrections,
        rate_retries: b.rate_retries,
        model_timeout_ms: b.model_timeout_ms,
        max_request_bytes: b.max_request_bytes,
        max_response_bytes: b.max_response_bytes,
        max_trace_bytes: b.max_trace_bytes,
      },
    },
  };
  const result = await (o.run ?? runAgent)(options),
    m = await readManifest(result.directory);
  if (
    result.run_id !== o.runId ||
    m.run_id !== o.runId ||
    result.record_error ||
    m.agent === "not_applicable" ||
    !m.agent ||
    !m.collaboration
  )
    throw new Error("Unconfirmed EDA record");
  return {
    id: o.id,
    source_experiment: o.request.source_experiment,
    dataset_hash: o.dataset.files[0]?.sha256 ?? "",
    split_hash: o.dataset.split.sha256,
    status: result.status,
    reason: result.reason,
    analysis: result.status === "completed" ? result.analysis : null,
    run_id: result.run_id,
    directory: result.directory,
    cost: ledger(m.tokens),
    role_usage: {
      planner: ledger(m.collaboration.roles.planner.tokens),
      executor: ledger(m.collaboration.roles.executor.tokens),
    },
    executions: m.agent.executions,
    request: o.request,
  };
}
export function validateEvidence(
  uses: EvidenceUse[],
  analyses: AnalysisRecord[],
  dataset: Dataset,
) {
  for (const use of uses) {
    const a = analyses.find((x) => x.id === use.analysis_id);
    if (
      !a ||
      a.status !== "completed" ||
      !a.analysis ||
      a.source_experiment !== use.source_experiment ||
      a.dataset_hash !== dataset.files[0]?.sha256 ||
      a.split_hash !== dataset.split.sha256
    )
      throw new Error("Evidence provenance mismatch");
    const refs = new Set(a.analysis.findings.flatMap((f) => f.evidence_refs));
    if (use.refs.some((r) => !refs.has(r)))
      throw new Error("Unknown evidence reference");
  }
}
