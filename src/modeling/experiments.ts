import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile, verifyFiles } from "../evaluation/files";
import type { ExecutionResult, SessionConfig } from "../execution/protocol";
import { DockerSession } from "../execution/session";
import { obj } from "../models/validation";
import { exportNotebooks } from "../records/notebook";
import { RunRecorder, readArtifact, sha256 } from "../records/store";
import type { ModelingExecutionTask } from "./config";
import {
  csv,
  type Dataset,
  datasetProtocol,
  finite,
  parseCsv,
  rowIds,
  select,
  type Table,
} from "./data";
import { validatePredictions } from "./predictions";
import { type Score, validateModelMetadata } from "./protocol";
import { ScoringFailure, scoreTables } from "./scoring";
import type { Evaluation, ExperimentPhase } from "./validation";

export interface StageResult {
  execution_confirmed?: boolean;
  stage_version?: 1 | 2 | 3;
  run_id: string;
  directory: string;
  status: string;
  reason: string;
  output: { path: string; sha256: string; bytes: number } | null;
  metadata?: { path: string; sha256: string; bytes: number };
  image: { id: string; platform: string };
  elapsed_ms: number;
}
export interface StageOptions {
  task: ModelingExecutionTask;
  dataset: Dataset;
  root: string;
  runId?: string;
  stage: "fit" | "predict";
  code: string;
  data: Table;
  entrypoint?: string;
  legacy?: boolean;
  stageVersion?: 2 | 3;
  modelSeed?: number;
  model?: Buffer;
  signal: AbortSignal;
  remainingMs: number;
  onIntent?: (runId: string) => Promise<void>;
}
export async function runStage(o: StageOptions): Promise<StageResult> {
  const began = performance.now(),
    runId = o.runId ?? randomUUID();
  if (o.signal.aborted) throw new Error("cancelled");
  await o.onIntent?.(runId);
  const inputs = resolve(o.root, "inputs", runId);
  await mkdir(inputs, { recursive: true });
  const values: Record<string, string | Buffer> = {
    "candidate.py": o.code,
    "data.csv": csv(o.data),
    "stage.json": JSON.stringify({
      ...(!o.legacy
        ? {
            schema_version: o.stageVersion ?? 3,
            protocol: datasetProtocol(o.dataset),
            ...(o.stageVersion !== 2
              ? {
                  model_artifact: {
                    compression: "zlib-3",
                    max_bytes: o.task.limits.max_artifact_bytes,
                  },
                }
              : {}),
          }
        : {}),
      target: o.dataset.target,
      id_column: o.dataset.id_column,
      seed: o.modelSeed ?? o.dataset.seed,
    }),
  };
  if (o.model) values["model.joblib"] = o.model;
  for (const [path, value] of Object.entries(values))
    await writeFile(join(inputs, path), value, { flag: "wx", mode: 0o444 });
  const identities = await Promise.all(
    Object.keys(values).map((p) => describeFile(inputs, p)),
  );
  const timeout = Math.max(
    1,
    Math.floor(Math.min(o.remainingMs, o.task.budget.task_timeout_ms)),
  );
  const config: SessionConfig = {
    run_id: runId,
    image: o.task.image,
    input_root: inputs,
    inputs: Object.keys(values),
    staging_root: resolve(o.root, ".staging"),
    seed: o.modelSeed ?? o.dataset.seed,
    limits: {
      ...o.task.limits,
      task_timeout_ms: timeout,
      startup_timeout_ms: Math.min(timeout, o.task.limits.startup_timeout_ms),
      cell_timeout_ms: Math.min(
        timeout,
        o.stage === "fit"
          ? o.task.budget.fit_timeout_ms
          : o.task.budget.predict_timeout_ms,
      ),
    },
  };
  const recorder = await RunRecorder.create({
    runRoot: resolve(o.root, "stages"),
    runId,
    config: { ...config },
    inputs: [],
    image: { id: "unresolved", platform: "unresolved" },
    seed: o.modelSeed ?? o.dataset.seed,
    maxArtifactBytes: config.limits.max_artifact_bytes,
    maxTotalArtifactBytes:
      config.limits.max_artifacts_bytes + config.limits.max_output_bytes,
  });
  let session: DockerSession | undefined,
    result: ExecutionResult | undefined,
    failure: string | undefined;
  let abortWork: Promise<void> | undefined;
  const abort = () => {
    if (session)
      abortWork = session.close().catch((e) => {
        failure = `cleanup:${String(e)}`;
      });
  };
  o.signal.addEventListener("abort", abort, { once: true });
  try {
    await verifyFiles(inputs, identities);
    session = await DockerSession.create(config, recorder);
    if (o.signal.aborted) throw new Error("cancelled");
    if (
      JSON.stringify(
        recorder.manifest.inputs.map((i) => ({
          path: i.path,
          bytes: i.size_bytes,
          sha256: i.sha256,
        })),
      ) !== JSON.stringify(identities)
    )
      throw new Error("Staged input mismatch");
    result = await session.execute(o.entrypoint ?? stageEntrypoint(o.stage));
    if (
      !result.started ||
      !result.kernel_available ||
      !result.persistence_complete
    )
      failure = `${result.status}:incomplete execution:${result.error?.evalue ?? result.diagnostic ?? "unconfirmed execution state"}`;
    else if (result.status !== "ok")
      failure = `${result.status}:${result.error?.evalue ?? result.diagnostic ?? "incomplete execution"}`;
  } catch (e) {
    failure = String(e);
  } finally {
    o.signal.removeEventListener("abort", abort);
    await abortWork;
    try {
      await session?.close();
    } catch (e) {
      failure = `cleanup:${String(e)}`;
    }
  }
  if (session?.closeResult && session.closeResult.status !== "ok")
    failure = `cleanup:${session.closeResult.status}:${failure ?? "unconfirmed close"}`;
  if (o.signal.aborted) failure = "cancelled";
  // This is a candidate failure only after the isolated worker and all records
  // have closed cleanly. Transport limits or unknown state remain fatal.
  if (
    !o.signal.aborted &&
    failure?.startsWith("error:") &&
    result?.status === "error" &&
    result.error?.ename === "ModelArtifactLimitError" &&
    result.started &&
    result.kernel_available &&
    result.persistence_complete &&
    session?.closeResult?.status === "ok" &&
    !session.closeResult.cleanup_error
  )
    failure = `model_artifact_limit:${result.error.evalue}`;
  let artifactsConfirmed = true;
  let output: StageResult["output"] = null;
  let metadata: StageResult["metadata"];
  if (!failure) {
    try {
      const name = o.stage === "fit" ? "model.joblib" : "predictions.csv";
      const artifact = recorder.manifest.artifacts.find(
        (a) => a.source_path === name && a.complete,
      );
      if (!artifact) throw new Error(`Missing complete ${name}`);
      const data = await readArtifact(recorder.directory, artifact);
      if (o.stage === "fit" && !o.legacy) {
        const a = recorder.manifest.artifacts.find(
          (a) => a.source_path === "model-metadata.json" && a.complete,
        );
        if (!a) throw new Error("Missing model metadata");
        const bytes = await readArtifact(recorder.directory, a),
          m = obj(JSON.parse(bytes.toString()));
        if (
          validateModelMetadata(m, o.dataset.id_column).protocol_sha256 !==
          datasetProtocol(o.dataset).protocol_sha256
        )
          throw new Error("Model metadata mismatch");
        metadata = { path: a.path, sha256: a.sha256, bytes: bytes.length };
      }
      output = {
        path: artifact.path,
        sha256: sha256(data),
        bytes: data.length,
      };
    } catch (e) {
      artifactsConfirmed = false;
      failure = String(e);
    }
  }
  await recorder.finish(failure ? "failed" : "completed");
  await exportNotebooks(recorder.directory);
  return {
    execution_confirmed: Boolean(
      result?.started &&
        result.kernel_available &&
        result.persistence_complete &&
        artifactsConfirmed &&
        session?.closeResult?.status === "ok" &&
        !session.closeResult.cleanup_error,
    ),
    stage_version: o.legacy ? 1 : (o.stageVersion ?? 3),
    run_id: runId,
    directory: recorder.directory,
    status: failure ? "failed" : "completed",
    reason: failure ?? "ok",
    output,
    ...(metadata ? { metadata } : {}),
    image: recorder.manifest.image,
    elapsed_ms: performance.now() - began,
  };
}
export function stageEntrypoint(stage: "fit" | "predict") {
  return `from statigent_modeling.runner import run\nrun(${JSON.stringify(stage)})\n`;
}
export async function stageBytes(stage: StageResult): Promise<Buffer> {
  if (stage.status !== "completed" || !stage.output)
    throw new Error("Incomplete stage");
  return readArtifact(stage.directory, {
    ...stage.output,
    size_bytes: stage.output.bytes,
    complete: true,
  });
}
export function predictionValues(
  table: Table,
  expected: string[],
  id: string,
): number[] {
  if (JSON.stringify(table.columns) !== JSON.stringify([id, "prediction"]))
    throw new Error("Invalid prediction columns");
  const ids = rowIds(table, id);
  if (ids.length !== expected.length || ids.some((x) => !expected.includes(x)))
    throw new Error("Prediction membership mismatch");
  const values = new Map(
    ids.map((x, i) => [x, finite(table.rows[i]?.[1] ?? "")]),
  );
  return expected.map((x) => {
    const n = values.get(x);
    if (n === undefined) throw new Error("Missing prediction");
    return n;
  });
}
export function rmse(predictions: number[], targets: number[]): number {
  if (!targets.length || predictions.length !== targets.length)
    throw new Error("Invalid score shape");
  let sum = 0;
  for (let i = 0; i < targets.length; i++) {
    const a = predictions[i],
      b = targets[i];
    if (
      a === undefined ||
      b === undefined ||
      !Number.isFinite(a) ||
      !Number.isFinite(b)
    )
      throw new Error("Non-finite score input");
    sum += (a - b) ** 2 / targets.length;
  }
  const score = Math.sqrt(sum);
  if (!Number.isFinite(score)) throw new Error("Score overflow");
  return score;
}
export interface TrainingDiagnostic {
  partition: "train";
  status: "available" | "unavailable";
  members_sha256: string;
  model_sha256: string;
  prediction: StageResult | null;
  score: Score | null;
  reason: string;
  elapsed_ms: number;
}
export interface Experiment {
  id: string;
  candidate_id: string;
  code: string;
  code_sha256: string;
  status: "completed" | "failed";
  reason: string;
  score: Score | null;
  fit: StageResult | null;
  predict: StageResult | null;
  final: boolean;
  phase?: ExperimentPhase;
  evaluation?: Evaluation;
  source_search_experiment_id?: string | null;
  training_diagnostic?: TrainingDiagnostic;
  execution_confirmed?: boolean;
}
export async function runExperiment(o: {
  task: ModelingExecutionTask;
  dataset: Dataset;
  train: Table;
  test: Table;
  code: string;
  candidateId: string;
  root: string;
  signal: AbortSignal;
  remaining: () => number;
  final?: boolean;
  evaluation?: Evaluation;
  sourceSearchExperimentId?: string;
  id?: string;
  onStage?: (id: string) => Promise<void>;
  entrypoints?: { fit: string; predict: string };
  legacy?: boolean;
  stageVersion?: 2 | 3;
  score?: typeof scoreTables;
}): Promise<Experiment> {
  const e: Experiment = {
    id: o.id ?? randomUUID(),
    candidate_id: o.candidateId,
    code: o.code,
    code_sha256: sha256(Buffer.from(o.code)),
    status: "failed",
    reason: "not_started",
    score: null,
    fit: null,
    predict: null,
    final: o.final ?? false,
    ...(o.evaluation
      ? {
          phase: o.evaluation.phase,
          evaluation: o.evaluation,
          source_search_experiment_id: o.sourceSearchExperimentId ?? null,
        }
      : {}),
  };
  if (
    o.evaluation &&
    ((o.evaluation.phase === "final") !== Boolean(o.final) ||
      o.evaluation.protocol_sha256 !==
        datasetProtocol(o.dataset).protocol_sha256 ||
      o.evaluation.train_sha256 !== o.dataset.files[0]?.sha256)
  )
    throw new Error("Experiment evaluation mismatch");
  const split = o.evaluation?.split ?? o.dataset.split;
  if (Buffer.byteLength(o.code) > o.task.limits.max_code_bytes)
    throw new Error("Code exceeds limit");
  const base = {
    task: o.task,
    dataset: o.dataset,
    root: o.root,
    code: o.code,
    signal: o.signal,
    onIntent: o.onStage,
    legacy: o.legacy,
    stageVersion: o.stageVersion,
    modelSeed: o.evaluation?.model_seed,
  };
  e.fit = await runStage({
    ...base,
    stage: "fit",
    entrypoint: o.entrypoints?.fit,
    data: o.final ? o.train : select(o.train, split.train, o.dataset.id_column),
    remainingMs: o.remaining(),
  });
  e.execution_confirmed = e.fit.execution_confirmed;
  if (e.fit.status !== "completed") {
    e.reason = e.fit.reason;
    return e;
  }
  if (o.signal.aborted || o.remaining() <= 0) {
    e.reason = "cancelled_or_deadline";
    return e;
  }
  e.predict = await runStage({
    ...base,
    task: { ...o.task, image: e.fit.image.id },
    stage: "predict",
    entrypoint: o.entrypoints?.predict,
    model: await stageBytes(e.fit),
    data: o.final
      ? o.test
      : select(o.train, split.validation, o.dataset.id_column, [
          o.dataset.target,
        ]),
    remainingMs: o.remaining(),
  });
  e.execution_confirmed =
    e.execution_confirmed !== false && e.predict.execution_confirmed !== false;
  if (e.predict.status !== "completed") {
    e.reason = e.predict.reason;
    return e;
  }
  try {
    const expected = o.final
      ? rowIds(o.test, o.dataset.id_column)
      : split.validation;
    const predictions = parseCsv((await stageBytes(e.predict)).toString());
    const protocol = datasetProtocol(o.dataset);
    validatePredictions(predictions, expected, o.dataset.id_column, protocol);
    if (!o.final) {
      const labels = select(
        o.train,
        expected,
        o.dataset.id_column,
        o.dataset.features,
      );
      const scored = await (o.score ?? scoreTables)({
        root: o.root,
        protocol,
        id: o.dataset.id_column,
        target: o.dataset.target,
        labels: {
          columns: [o.dataset.id_column, o.dataset.target],
          rows: labels.rows.map((r) => [
            r[labels.columns.indexOf(o.dataset.id_column)] ?? "",
            r[labels.columns.indexOf(o.dataset.target)] ?? "",
          ]),
        },
        predictions,
        signal: o.signal,
        timeout_ms: o.remaining(),
      });
      if (!scored.score) throw new Error(scored.error ?? "Invalid score");
      e.score = {
        ...scored.score,
        ...(o.evaluation ? { evaluation_id: o.evaluation.evaluation_id } : {}),
      };
    }
    e.status = "completed";
    e.reason = "ok";
  } catch (error) {
    e.reason = String(error);
    if (error instanceof ScoringFailure) e.reason = error.message;
  }
  if (
    e.status === "completed" &&
    o.evaluation?.phase === "search" &&
    "schema_version" in o.task &&
    o.task.schema_version === 3
  ) {
    const began = performance.now();
    const diagnostic: TrainingDiagnostic = {
      partition: "train",
      status: "unavailable",
      members_sha256: sha256(Buffer.from(JSON.stringify(split.train))),
      model_sha256: e.fit.output?.sha256 ?? "",
      prediction: null,
      score: null,
      reason: "not_started",
      elapsed_ms: 0,
    };
    e.training_diagnostic = diagnostic;
    if (o.remaining() <= 0 && !o.signal.aborted) {
      diagnostic.reason = "exploration_reserve";
      return e;
    }
    try {
      diagnostic.prediction = await runStage({
        ...base,
        task: { ...o.task, image: e.fit.image.id },
        stage: "predict",
        entrypoint: o.entrypoints?.predict,
        model: await stageBytes(e.fit),
        data: select(o.train, split.train, o.dataset.id_column, [
          o.dataset.target,
        ]),
        remainingMs: o.remaining(),
      });
      if (diagnostic.prediction.status !== "completed")
        throw new Error(diagnostic.prediction.reason);
      const predictions = parseCsv(
          (await stageBytes(diagnostic.prediction)).toString(),
        ),
        protocol = datasetProtocol(o.dataset);
      validatePredictions(
        predictions,
        split.train,
        o.dataset.id_column,
        protocol,
      );
      const training = select(o.train, split.train, o.dataset.id_column);
      const scored = await (o.score ?? scoreTables)({
        root: o.root,
        protocol,
        id: o.dataset.id_column,
        target: o.dataset.target,
        labels: {
          columns: [o.dataset.id_column, o.dataset.target],
          rows: training.rows.map((r) => [
            r[training.columns.indexOf(o.dataset.id_column)] ?? "",
            r[training.columns.indexOf(o.dataset.target)] ?? "",
          ]),
        },
        predictions,
        signal: o.signal,
        timeout_ms: o.remaining(),
      });
      if (!scored.score)
        throw new Error(scored.error ?? "Invalid diagnostic score");
      diagnostic.score = {
        ...scored.score,
        evaluation_id: sha256(
          Buffer.from(
            JSON.stringify({
              partition: "train",
              search_evaluation_id: o.evaluation.evaluation_id,
              members_sha256: diagnostic.members_sha256,
            }),
          ),
        ),
      };
      diagnostic.status = "available";
      diagnostic.reason = "ok";
    } catch (error) {
      diagnostic.reason = String(error);
      // A normal auxiliary prediction error does not erase the validation result.
      // Unknown execution, damaged artifacts or failed cleanup cannot authorize more work.
      if (
        !diagnostic.prediction ||
        diagnostic.prediction.execution_confirmed === false ||
        /kernel_lost|protocol_error|cleanup|record|incomplete|integrity|hash|scoring_failure/.test(
          diagnostic.reason,
        )
      ) {
        e.execution_confirmed = false;
        e.reason = `diagnostic_integrity_failure:${diagnostic.reason}`;
      }
    } finally {
      diagnostic.elapsed_ms = performance.now() - began;
    }
  }
  return e;
}
