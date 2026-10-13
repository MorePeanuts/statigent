import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Analysis } from "../agent/actions";
import { DEFAULT_BUDGET } from "../agent/config";
import { type RunOptions, runAgent } from "../agent/run";
import { describeFile } from "../evaluation/files";
import type { ModelClient } from "../models/client";
import type { ModelProfile } from "../models/config";
import { emptyLedger } from "../records/agent-metadata";
import { readManifest, sha256 } from "../records/store";
import type { EvidenceUse, ModelingAction } from "./actions";
import { type EffectiveBudget, ledger, roleLedgers } from "./budget";
import { identifier } from "./candidates";
import type { ModelingTask } from "./config";
import {
  csv,
  type Dataset,
  datasetProtocol,
  parseCsv,
  select,
  type Table,
} from "./data";
import { type Experiment, stageBytes } from "./experiments";
import { validatePredictions } from "./predictions";
import { assertEvaluation, evaluation } from "./validation";
export interface AnalysisRecord {
  id: string;
  source_experiment: string | null;
  source_experiments?: { experiment_id: string; prediction_sha256: string }[];
  source_sha256?: string;
  context_sha256?: string;
  dataset_hash: string;
  split_hash: string;
  protocol_sha256?: string;
  prediction_sha256?: string | null;
  status: string;
  reason: string;
  analysis: Analysis | null;
  run_id: string;
  directory: string | null;
  dispatch?: "started" | "not_started";
  effective_budget?: EffectiveBudget;
  deadline?: number;
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
  experiment: Experiment | Experiment[] | null,
  context: unknown = {},
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
  const protocol = datasetProtocol(dataset);
  const experiments =
    experiment === null
      ? []
      : Array.isArray(experiment)
        ? experiment
        : [experiment];
  if (
    experiments.length > 2 ||
    new Set(experiments.map((e) => e.id)).size !== experiments.length
  )
    throw new Error("Invalid analysis sources");
  const sources: Record<string, unknown>[] = [];
  if (
    experiments.some(
      (e) => Boolean(e.evaluation) !== Boolean(experiments[0]?.evaluation),
    )
  )
    throw new Error("Mixed analysis evaluation identities");
  for (const experiment of experiments) {
    identifier(experiment.id);
    if (experiment.evaluation) {
      if (experiment.phase !== "search")
        throw new Error("Analysis requires search evaluation");
      assertEvaluation(
        experiment.evaluation,
        evaluation(dataset, "search", dataset.split, dataset.seed),
      );
    }
    let predictionHash: string | null = null;
    let fields: {
      prediction: string;
      probabilities: { column: string; label: string }[];
    } | null = null;
    if (experiment) {
      if (
        experiment.status !== "completed" ||
        !experiment.predict ||
        experiment.final
      )
        throw new Error("Invalid analysis experiment");
      const bytes = await stageBytes(experiment.predict);
      predictionHash = sha256(bytes);
      const values = validatePredictions(
        parseCsv(bytes.toString()),
        dataset.split.validation,
        dataset.id_column,
        protocol,
      );
      const table = select(train, dataset.split.validation, dataset.id_column);
      let prediction = "__prediction";
      while (table.columns.includes(prediction)) prediction += "_";
      const columns = [...table.columns, prediction];
      const probabilities = values.probabilities
        ? protocol.classes.map((label, i) => {
            let column = `__probability_${i}`;
            while (columns.includes(column)) column += "_";
            columns.push(column);
            return { column, label };
          })
        : [];
      fields = { prediction, probabilities };
      const errors = {
        columns,
        rows: table.rows.map((r, i) => [
          ...r,
          String(values.values[i]),
          ...(values.probabilities?.[i]?.map(String) ?? []),
        ]),
      };
      await writeFile(
        join(
          root,
          experiments.length === 1
            ? "validation.csv"
            : `validation-${experiment.id}.csv`,
        ),
        csv(errors),
        {
          flag: "wx",
          mode: 0o444,
        },
      );
      inputs.push(
        experiments.length === 1
          ? "validation.csv"
          : `validation-${experiment.id}.csv`,
      );
    }
    sources.push({
      experiment_id: experiment.id,
      prediction_sha256: predictionHash,
      fields,
      path: inputs.at(-1),
      evaluation_id: experiment.evaluation?.evaluation_id ?? null,
      model_seed: experiment.evaluation?.model_seed ?? dataset.seed,
      split_sha256: dataset.split.sha256,
    });
  }
  await writeFile(
    join(root, "source.json"),
    JSON.stringify({
      version: 2,
      sources,
      experiment_id: experiments[0]?.id ?? null,
      protocol,
      prediction_sha256: sources[0]?.prediction_sha256 ?? null,
      fields: sources[0]?.fields ?? null,
      target: dataset.target,
      id_column: dataset.id_column,
      data: dataset.files[0],
      split_sha256: dataset.split.sha256,
    }),
    { flag: "wx", mode: 0o444 },
  );
  inputs.push("source.json");
  const contextBytes = JSON.stringify(context);
  if (Buffer.byteLength(contextBytes) > 131072)
    throw new Error("Analysis context limit");
  await writeFile(join(root, "context.json"), contextBytes, {
    flag: "wx",
    mode: 0o444,
  });
  inputs.push("context.json");
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
  experiments?: Experiment[];
  context?: unknown;
  request: Extract<ModelingAction, { kind: "analyze" }>;
  resolvedCandidates: {
    id: string;
    hypothesis: string;
    change: string;
    priority: number;
  }[];
  profile: ModelProfile;
  signal: AbortSignal;
  budget: EffectiveBudget;
  /** Monotonic deadline fixed when the parent accepts this delegation. */
  deadline: number;
  now?: () => number;
  prepare?: typeof prepareAnalysisInput;
  client?: ModelClient;
  run?: typeof runAgent;
}): Promise<AnalysisRecord> {
  const now = o.now ?? (() => performance.now());
  if (!Number.isFinite(o.deadline)) throw new Error("Invalid EDA deadline");
  const notStarted = (status: string, reason: string): AnalysisRecord => ({
    id: o.id,
    source_experiment: o.request.source_experiments[0] ?? null,
    dataset_hash: o.dataset.files[0]?.sha256 ?? "",
    split_hash: o.dataset.split.sha256,
    protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
    prediction_sha256: o.experiment?.predict?.output?.sha256 ?? null,
    status,
    reason,
    analysis: null,
    run_id: o.runId,
    directory: null,
    dispatch: "not_started",
    effective_budget: o.budget,
    deadline: o.deadline,
    cost: emptyLedger(),
    role_usage: { planner: emptyLedger(), executor: emptyLedger() },
    executions: 0,
    request: o.request,
  });
  const stopped = () =>
    o.signal.aborted
      ? notStarted("cancelled", "user_cancelled_before_eda_dispatch")
      : now() >= o.deadline
        ? notStarted("timed_out", "eda_deadline_before_dispatch")
        : null;
  const initialStop = stopped();
  if (initialStop) return initialStop;
  const input = join(o.root, `${o.id}-input`);
  let inputs: string[];
  try {
    inputs = await (o.prepare ?? prepareAnalysisInput)(
      input,
      o.dataset,
      o.train,
      o.experiments ?? o.experiment,
      o.context ?? {},
    );
  } catch (error) {
    return (
      stopped() ??
      notStarted(
        "failed",
        `eda_input_preparation: ${error instanceof Error ? error.message : String(error)}`,
      )
    );
  }
  const preparedStop = stopped();
  if (preparedStop) return preparedStop;
  const sourceFile = await describeFile(input, "source.json");
  const contextFile = await describeFile(input, "context.json");
  const b = o.task.budget;
  const options: RunOptions = {
    runId: o.runId,
    deadline: o.deadline,
    runRoot: join(o.root, "eda"),
    profile: o.profile,
    signal: o.signal,
    client: o.client,
    task: {
      organization: "planner-executor",
      completion_policy: "modeling-diagnostic-v1",
      goal: JSON.stringify({ ...o.request, candidates: o.resolvedCandidates }),
      constraints: [
        "Investigate the requested exploration, model diagnosis or comparison. context.json contains historical knowledge with original provenance, not new execution evidence. This is internal validation, never external test evaluation.",
        "Return concise evidence and methods. Do not write a Markdown report or train candidate models. source.json identifies data, target and prediction provenance.",
        "Focus on the requested question: inspect existing predictions, residual groups and data statistics first. Do not refit models, run feature searches or tune hyperparameters here; return those proposals to the modeling agent for controlled experiments. Return once the question has useful evidence; list new questions as limitations instead of expanding the task. Keep findings concise (at most 6), with exact valid evidence IDs. When the host announces closing, return supported findings and explicitly state anything unresolved; the planner must preserve those limitations in finish_analysis.",
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
  const cost = ledger(m.tokens),
    roles = roleLedgers(cost, {
      planner: m.collaboration.roles.planner.tokens,
      executor: m.collaboration.roles.executor.tokens,
    });
  for (const dimension of [
    "model_attempts",
    "total_tokens",
    "executions",
    "task_timeout_ms",
  ] as const)
    if (m.agent.budget[dimension] !== o.budget[dimension])
      throw new Error("Unconfirmed EDA budget configuration");
  return {
    id: o.id,
    source_experiment: o.request.source_experiments[0] ?? null,
    dataset_hash: o.dataset.files[0]?.sha256 ?? "",
    split_hash: o.dataset.split.sha256,
    protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
    prediction_sha256: o.experiment?.predict?.output?.sha256 ?? null,
    source_sha256: sourceFile.sha256,
    context_sha256: contextFile.sha256,
    source_experiments: (
      o.experiments ?? (o.experiment ? [o.experiment] : [])
    ).map((e) => {
      if (!e.predict?.output) throw new Error("Missing confirmed prediction");
      return {
        experiment_id: e.id,
        prediction_sha256: e.predict.output.sha256,
      };
    }),
    status: result.status,
    reason: result.reason,
    analysis: result.status === "completed" ? result.analysis : null,
    run_id: result.run_id,
    directory: result.directory,
    dispatch: "started",
    effective_budget: o.budget,
    deadline: o.deadline,
    cost,
    role_usage: roles,
    executions: m.agent.executions,
    request: o.request,
  };
}
export function validateEvidence(
  uses: EvidenceUse[],
  analyses: AnalysisRecord[],
  dataset: Dataset,
  experiments?: readonly Experiment[],
) {
  for (const use of uses) {
    const a = analyses.find((x) => x.id === use.analysis_id);
    if (
      !a ||
      a.status !== "completed" ||
      !a.analysis ||
      (a.source_experiments
        ? use.source_experiment === null
          ? a.source_experiments.length !== 0
          : !a.source_experiments.some(
              (s) => s.experiment_id === use.source_experiment,
            )
        : a.source_experiment !== use.source_experiment) ||
      a.dataset_hash !== dataset.files[0]?.sha256 ||
      a.split_hash !== dataset.split.sha256
    )
      throw new Error("Evidence provenance mismatch");
    if (dataset.schema_version === 2 || a.protocol_sha256 !== undefined) {
      if (a.protocol_sha256 !== datasetProtocol(dataset).protocol_sha256)
        throw new Error("Evidence protocol mismatch");
      if (experiments) {
        for (const ref of a.source_experiments ?? []) {
          const source = experiments.find((e) => e.id === ref.experiment_id);
          if (
            !source ||
            source.final ||
            source.status !== "completed" ||
            source.predict?.output?.sha256 !== ref.prediction_sha256
          )
            throw new Error("Evidence prediction provenance mismatch");
        }
        const source = experiments.find((e) => e.id === a.source_experiment);
        if (
          a.source_experiment &&
          (!source || source.status !== "completed" || source.final)
        )
          throw new Error("Evidence experiment mismatch");
        if (a.prediction_sha256 !== (source?.predict?.output?.sha256 ?? null))
          throw new Error("Evidence prediction mismatch");
      }
    }
    const refs = new Set(a.analysis.findings.flatMap((f) => f.evidence_refs));
    if (use.refs.some((r) => !refs.has(r)))
      throw new Error("Unknown evidence reference");
  }
}
