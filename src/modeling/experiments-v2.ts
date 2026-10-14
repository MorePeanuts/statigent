import { resolve } from "node:path";
import { verifyFiles } from "../evaluation/files";
import type { ModelingExecutionTask } from "./config";
import type { DatasetV3 } from "./dataset-v3";
import { executeExperimentLifecycle } from "./experiment-lifecycle";
import { runStage, type StageResult, stageBytes } from "./experiments";
import { validatePredictionFilesV2 } from "./predictions-v2";
import type { ScoreV2 } from "./score-v2";
import { type ScoringFileV2, scoreFilesV2 } from "./scoring-v2";
import { selectFileV2 } from "./table-ops";
import { assertEvaluation, type Evaluation, evaluation } from "./validation";

export async function stageFile(stage: StageResult): Promise<ScoringFileV2> {
  if (stage.status !== "completed" || !stage.output)
    throw new Error("Incomplete stage");
  await verifyFiles(stage.directory, [stage.output]);
  return { ...stage.output, path: resolve(stage.directory, stage.output.path) };
}

export async function runExperimentV2(o: {
  task: ModelingExecutionTask;
  dataset: DatasetV3;
  sourceRoot: string;
  code: string;
  candidateId: string;
  root: string;
  signal: AbortSignal;
  remaining: () => number;
  evaluation: Evaluation;
  fitOnly?: boolean;
  sourceSearchExperimentId?: string;
  id?: string;
  onStage?: (id: string) => Promise<void>;
  stage?: typeof runStage;
}) {
  const p = o.dataset.protocol,
    e = o.evaluation,
    final = e.phase === "final";
  assertEvaluation(
    e,
    evaluation(o.dataset, e.phase, e.split, e.model_seed, e.split_seed),
  );
  const absolute = (file: ScoringFileV2) => ({
    ...file,
    path: resolve(o.sourceRoot, file.path),
  });
  const training = absolute(o.dataset.training);
  const select = async (columns: string[], members: string[]) =>
    (
      await selectFileV2({
        root: o.root,
        source: training,
        columns,
        members,
        limits: o.dataset.limits,
        signal: o.signal,
        timeout_ms: o.remaining(),
      })
    ).file;
  const publicColumns = [p.id_column, ...p.feature_columns];
  const predictionInputs = new Map<string, ScoringFileV2>();
  const base = {
    task: o.task,
    dataset: o.dataset,
    root: o.root,
    code: o.code,
    signal: o.signal,
    onIntent: o.onStage,
    stageVersion: 4 as const,
    featureSchema: absolute(o.dataset.feature_schema),
    modelSeed: e.model_seed,
  };
  const stage = o.stage ?? runStage;
  return executeExperimentLifecycle<ScoreV2>({
    id: o.id,
    candidateId: o.candidateId,
    code: o.code,
    maxCodeBytes: o.task.limits.max_code_bytes,
    final,
    fitOnly: o.fitOnly,
    evaluation: e,
    sourceSearchExperimentId: o.sourceSearchExperimentId,
    members: e.split.train,
    diagnostic: true,
    signal: o.signal,
    remaining: o.remaining,
    fit: async () => {
      // 即使最终拟合也按冻结成员物化；此分支完全不读取预测分区。
      const data = await select(
        [...publicColumns, ...p.targets.map((t) => t.name)],
        e.split.train,
      );
      return stage({ ...base, stage: "fit", data, remainingMs: o.remaining() });
    },
    predict: async (fit, partition) => {
      let data: ScoringFileV2;
      if (partition === "test") {
        if (!final || !o.dataset.prediction)
          throw new Error("Missing final prediction partition");
        data = absolute(o.dataset.prediction);
      } else
        data = await select(
          publicColumns,
          partition === "training" ? e.split.train : e.split.validation,
        );
      predictionInputs.set(partition, data);
      return stage({
        ...base,
        task: { ...o.task, image: fit.image.id },
        stage: "predict",
        data,
        model: await stageBytes(fit),
        remainingMs: o.remaining(),
      });
    },
    validateAndScore: async (prediction, partition, evaluationId) => {
      const predictions = await stageFile(prediction);
      const expected = predictionInputs.get(partition);
      if (!expected || !evaluationId)
        throw new Error("Missing prediction partition identity");
      await validatePredictionFilesV2({
        root: o.root,
        protocol: p,
        expected,
        predictions,
        limits: o.dataset.limits,
        signal: o.signal,
        timeout_ms: o.remaining(),
      });
      if (partition === "test") return null;
      const labels = await select(
        [p.id_column, ...p.targets.map((t) => t.name)],
        partition === "training" ? e.split.train : e.split.validation,
      );
      const result = await scoreFilesV2({
        root: o.root,
        protocol: p,
        evaluation_id: evaluationId,
        partition:
          e.phase === "search"
            ? partition === "training"
              ? "search-training"
              : "search-validation"
            : partition === "training"
              ? "confirmation-training"
              : "confirmation-validation",
        labels,
        predictions,
        limits: o.dataset.limits,
        signal: o.signal,
        timeout_ms: o.remaining(),
      });
      if (!result.score) throw new Error(result.error ?? "Invalid score");
      return result.score;
    },
  });
}
