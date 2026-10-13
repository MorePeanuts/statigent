import { constants } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { verifyFiles } from "../evaluation/files";
import { sha256 } from "../records/store";
import { identifier } from "./candidates";
import type { DatasetV3 } from "./dataset-v3";
import { type AnalysisOptions, analyzeWithInput } from "./eda";
import type { Experiment } from "./experiments";
import { stageFile } from "./experiments-v2";
import { validatePredictionFilesV2 } from "./predictions-v2";
import { type ScoreV2, validateScoreV2 } from "./score-v2";
import type { ScoringFileV2 } from "./scoring-v2";
import { selectFileV2 } from "./table-ops";
import { assertEvaluation, evaluation } from "./validation";
import type { MembersV2 } from "./validation-v2";
import { validateEvaluationScore } from "./versioned-score";

export async function prepareAnalysisInputV2(o: {
  root: string;
  workRoot: string;
  sourceRoot: string;
  dataset: DatasetV3;
  members: MembersV2;
  experiments: readonly Experiment<ScoreV2>[];
  context: unknown;
  signal: AbortSignal;
  remaining: () => number;
}) {
  const p = o.dataset.protocol;
  if (
    o.experiments.length > 2 ||
    new Set(o.experiments.map((e) => e.id)).size !== o.experiments.length
  )
    throw new Error("Invalid analysis sources");
  const context = JSON.stringify(o.context);
  if (Buffer.byteLength(context) > 131072)
    throw new Error("Analysis context limit");
  await mkdir(o.root, { recursive: false });
  const inputs: string[] = [];
  const absolute = (f: ScoringFileV2) => ({
    ...f,
    path: resolve(o.sourceRoot, f.path),
  });
  const copy = async (f: ScoringFileV2, name: string) => {
    if (o.signal.aborted || o.remaining() <= 0)
      throw new Error("EDA input deadline/cancelled");
    if (f.bytes > o.dataset.limits.max_file_bytes)
      throw new Error("EDA input file limit");
    await verifyFiles(dirname(f.path), [{ ...f, path: basename(f.path) }]);
    await copyFile(f.path, join(o.root, name), constants.COPYFILE_EXCL);
    await chmod(join(o.root, name), 0o444);
    await verifyFiles(o.root, [{ ...f, path: name }]);
    inputs.push(name);
    return { ...f, path: name };
  };
  const training = absolute(o.dataset.training);
  const data = await copy(training, "train.csv");
  const schema = await copy(
    absolute(o.dataset.feature_schema),
    "features.json",
  );
  const columns = [
    p.id_column,
    ...p.feature_columns,
    ...p.targets.map((t) => t.name),
  ];
  const select = async (members: string[]) =>
    (
      await selectFileV2({
        root: o.workRoot,
        source: training,
        columns,
        members,
        limits: o.dataset.limits,
        signal: o.signal,
        timeout_ms: o.remaining(),
      })
    ).file;
  let validation: ScoringFileV2 | null = null,
    fit: ScoringFileV2 | null = null;
  const sources: Record<string, unknown>[] = [];
  for (const e of o.experiments) {
    identifier(e.id);
    if (
      e.status !== "completed" ||
      e.final ||
      e.phase !== "search" ||
      !e.evaluation ||
      !e.predict
    )
      throw new Error("Analysis requires successful search experiment");
    assertEvaluation(
      e.evaluation,
      evaluation(o.dataset, "search", o.members, o.dataset.seed),
    );
    validateEvaluationScore(e.score, p, e.evaluation);
    if (!validation) {
      validation = await select(o.members.validation);
      await copy(validation, "validation.csv");
    }
    const prediction = await stageFile(e.predict);
    await validatePredictionFilesV2({
      root: o.workRoot,
      protocol: p,
      expected: validation,
      predictions: prediction,
      limits: o.dataset.limits,
      signal: o.signal,
      timeout_ms: o.remaining(),
    });
    const published = await copy(prediction, `predictions-${e.id}.csv`);
    const d = e.training_diagnostic;
    let diagnostic: Record<string, unknown> = {
      status: "unavailable",
      reason: d?.reason ?? "not_recorded",
    };
    if (d?.status === "available") {
      if (
        !d.prediction ||
        d.partition !== "train" ||
        d.model_sha256 !== e.fit?.output?.sha256 ||
        d.members_sha256 !==
          sha256(Buffer.from(JSON.stringify(o.members.train)))
      )
        throw new Error("Training diagnostic provenance mismatch");
      const identity = sha256(
        Buffer.from(
          JSON.stringify({
            partition: "train",
            search_evaluation_id: e.evaluation.evaluation_id,
            members_sha256: d.members_sha256,
          }),
        ),
      );
      validateScoreV2(d.score, p, {
        evaluation_id: identity,
        partition: "search-training",
      });
      if (!fit) {
        fit = await select(o.members.train);
        await copy(fit, "training-diagnostics-input.csv");
      }
      const predictions = await stageFile(d.prediction);
      await validatePredictionFilesV2({
        root: o.workRoot,
        protocol: p,
        expected: fit,
        predictions,
        limits: o.dataset.limits,
        signal: o.signal,
        timeout_ms: o.remaining(),
      });
      const file = await copy(predictions, `training-predictions-${e.id}.csv`);
      diagnostic = {
        status: "available",
        partition: "train",
        data: "training-diagnostics-input.csv",
        predictions: file,
        score: d.score,
        model_sha256: d.model_sha256,
        members_sha256: d.members_sha256,
      };
    }
    sources.push({
      experiment_id: e.id,
      partition: "validation",
      data: "validation.csv",
      predictions: published,
      prediction_sha256: prediction.sha256,
      fields: p.prediction,
      targets: p.targets,
      score: e.score,
      training: diagnostic,
      evaluation_id: e.evaluation.evaluation_id,
      model_seed: e.evaluation.model_seed,
      split_sha256: o.members.sha256,
    });
  }
  const source = {
    version: 3,
    sources,
    protocol: p,
    targets: p.targets,
    id_column: p.id_column,
    data,
    feature_schema: schema,
    split_sha256: o.members.sha256,
    missing_policy: "escaped-null-v1",
    interpretation:
      "Join data and each prediction file by id, never by row position. All targets and prediction fields retain frozen order. features.json describes every feature and missing-value decoding. Training diagnostics describe fit and must not replace validation scores. No external test data is included.",
  };
  for (const [name, bytes] of [
    ["source.json", JSON.stringify(source)],
    ["split.json", JSON.stringify(o.members)],
    ["context.json", context],
  ] as const) {
    if (Buffer.byteLength(bytes) > o.dataset.limits.max_file_bytes)
      throw new Error("EDA metadata file limit");
    await writeFile(join(o.root, name), bytes, { flag: "wx", mode: 0o444 });
    inputs.push(name);
  }
  return inputs;
}

export async function analyzeV2(
  o: Omit<AnalysisOptions, "experiment" | "experiments"> & {
    dataset: DatasetV3;
    sourceRoot: string;
    members: MembersV2;
    experiment: Experiment<ScoreV2> | null;
    experiments?: Experiment<ScoreV2>[];
  },
) {
  return analyzeWithInput({
    ...o,
    identity: {
      dataset_hash: o.dataset.training.sha256,
      split_hash: o.members.sha256,
      protocol_sha256: o.dataset.protocol.protocol_sha256,
      seed: o.dataset.seed,
    },
    prepareInput: (root) =>
      prepareAnalysisInputV2({
        root,
        workRoot: o.root,
        sourceRoot: o.sourceRoot,
        dataset: o.dataset,
        members: o.members,
        experiments: o.experiments ?? (o.experiment ? [o.experiment] : []),
        context: o.context ?? {},
        signal: o.signal,
        remaining: () =>
          Math.max(0, o.deadline - (o.now?.() ?? performance.now())),
      }),
  });
}
