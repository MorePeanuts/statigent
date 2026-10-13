import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describeFile, regular, verifyFiles } from "../evaluation/files";
import { integer, obj, str } from "../models/validation";
import { safeRelativePath, sha256 } from "../records/store";
import {
  comparePredictionFilesV2,
  PREDICTION_TOLERANCE,
} from "./comparison-v2";
import type { Experiment } from "./experiments";
import { runExperimentV2 } from "./experiments-v2";
import {
  freezeModel,
  loadFrozenModel,
  parseFrozenModel,
  predictFrozenModel,
} from "./frozen-model";
import { validatePredictionFilesV2 } from "./predictions-v2";
import { canonicalJson } from "./protocol-v2";
import type { ScoreV2 } from "./score-v2";
import { type ScoringFileV2, scoreFilesV2 } from "./scoring-v2";
import { validationPlanFromFilesV2 } from "./validation-v2";

function same(a: unknown, b: unknown, label: string) {
  if (!isDeepStrictEqual(a, b)) throw new Error(`${label} mismatch`);
}
async function json(root: string, path: string) {
  const file = await regular(root, path);
  if ((await stat(file)).size > 32 * 1024 * 1024)
    throw new Error("Delivery metadata file limit");
  return obj(JSON.parse(await readFile(file, "utf8")));
}
function file(value: unknown): ScoringFileV2 {
  const f = obj(value),
    hash = str(f.sha256, "file SHA256");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid file hash");
  return {
    path: str(f.path, "file path"),
    bytes: integer(f.bytes, "file bytes", 0),
    sha256: hash,
  };
}

// 离线重评只验证公开预测及其冻结身份，不打开原生模型或训练阶段目录。
export async function predictionDeliveryV5(root: string) {
  root = resolve(root);
  const parent = await json(root, "modeling.json");
  if (
    parent.schema_version !== 5 ||
    parent.kind !== "modeling" ||
    parent.status !== "completed"
  )
    throw new Error("Expected completed schema 5 prediction delivery");
  const delivery = await json(root, "delivery/delivery.json");
  same(obj(parent.delivery).artifact, delivery, "Delivery snapshot");
  if (delivery.schema_version !== 5 || delivery.status !== "completed")
    throw new Error("Incomplete prediction delivery");
  const frozen = parseFrozenModel(delivery.frozen);
  same(
    await json(root, "frozen/model.json"),
    frozen,
    "Frozen delivery identity",
  );
  const prediction = obj(delivery.prediction),
    id = str(prediction.run_id, "prediction ID");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new Error("Invalid prediction ID");
  const predictionRoot = resolve(root, "predictions", id);
  same(prediction.directory, predictionRoot, "Prediction root");
  same(
    await json(predictionRoot, "prediction.json"),
    prediction,
    "Prediction snapshot",
  );
  same(prediction.frozen_id, frozen.frozen_id, "Prediction model identity");
  same(prediction.model_sha256, frozen.model.sha256, "Prediction model bytes");
  same(
    prediction.calls,
    { models: 0, fits: 0, predictions: 1 },
    "Prediction call boundary",
  );
  if (
    prediction.status !== "completed" ||
    prediction.execution_confirmed !== true ||
    !frozen.dataset.prediction
  )
    throw new Error("Unconfirmed prediction delivery");
  const stage = obj(prediction.stage),
    stageId = str(stage.run_id, "stage ID");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(stageId))
    throw new Error("Invalid prediction stage ID");
  same(
    stage.directory,
    resolve(predictionRoot, "stages", stageId),
    "Prediction stage directory",
  );
  const output = file(stage.output);
  safeRelativePath(output.path);
  if (!output.path.startsWith("artifacts/"))
    throw new Error("Invalid prediction artifact area");
  const predictions = {
    ...output,
    path: resolve(str(stage.directory, "stage directory"), output.path),
  };
  same(prediction.predictions, predictions, "Prediction bytes identity");
  const expected = {
    ...frozen.dataset.prediction,
    path: resolve(predictionRoot, "inputs", stageId, "data.csv"),
  };
  for (const ref of [expected, predictions]) {
    const path = safeRelativePath(relative(root, ref.path));
    if (ref.bytes > frozen.dataset.limits.max_file_bytes)
      throw new Error("Delivery file limit");
    await verifyFiles(root, [{ ...ref, path }]);
  }
  return { root, parent, delivery, frozen, expected, predictions };
}

export async function reproduceV5(
  root: string,
  runRoot: string,
  mode: "predict" | "refit",
) {
  const begin = performance.now(),
    directory = resolve(runRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  let status = "failed",
    reason = "not_started",
    sourceIdentity: string | null = null;
  let result: Awaited<ReturnType<typeof predictFrozenModel>> | null = null,
    refit: Experiment<ScoreV2> | null = null,
    comparison: Awaited<ReturnType<typeof comparePredictionFilesV2>> | null =
      null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refitDispatched = false,
    predictionDispatched = false;
  try {
    const source = await predictionDeliveryV5(root),
      frozen = await loadFrozenModel(source.root);
    sourceIdentity = frozen.frozen_id;
    const controller = new AbortController(),
      remaining = () =>
        Math.max(
          0,
          Math.floor(
            frozen.task.budget.final_reserve_ms - (performance.now() - begin),
          ),
        );
    timer = setTimeout(() => controller.abort(), Math.max(1, remaining()));
    let modelRoot = source.root;
    if (mode === "refit") {
      const plan = await validationPlanFromFilesV2(
        frozen.task.dataset_root,
        frozen.dataset,
        frozen.task.confirmation.mode,
      );
      same(plan, source.delivery.validation_plan, "Refit frozen plan");
      const code = await readFile(
        await regular(source.root, frozen.code.path),
        "utf8",
      );
      refitDispatched = true;
      refit = await runExperimentV2({
        root: directory,
        sourceRoot: frozen.task.dataset_root,
        dataset: frozen.dataset,
        task: { ...frozen.task, image: frozen.image.id },
        code,
        candidateId: frozen.selected_experiment_id,
        signal: controller.signal,
        remaining,
        evaluation: plan.final,
        fitOnly: true,
        sourceSearchExperimentId: frozen.selected_experiment_id,
      });
      if (refit.status !== "completed")
        throw new Error(`refit_failed:${refit.reason}`);
      const selected: Experiment<ScoreV2> = {
        id: frozen.selected_experiment_id,
        candidate_id: frozen.selected_experiment_id,
        code,
        code_sha256: frozen.code.sha256,
        status: "completed",
        reason: "frozen_source",
        score: frozen.validation_score,
        fit: null,
        predict: null,
        final: false,
        phase: "search",
        evaluation: plan.search,
      };
      await freezeModel({
        root: directory,
        sourceRoot: frozen.task.dataset_root,
        dataset: frozen.dataset,
        task: frozen.task,
        selected,
        final: refit,
        plan,
      });
      modelRoot = directory;
    }
    predictionDispatched = true;
    result = await predictFrozenModel({
      frozenRoot: modelRoot,
      runRoot: join(directory, "predictions"),
      features: source.expected,
      timeout_ms: remaining(),
      signal: controller.signal,
    });
    if (result.status !== "completed" || !result.predictions)
      throw new Error(`prediction_failed:${result.reason}`);
    comparison = await comparePredictionFilesV2({
      root: directory,
      protocol: frozen.dataset.protocol,
      expected: source.expected,
      reference: source.predictions,
      actual: result.predictions,
      limits: frozen.dataset.limits,
      timeout_ms: remaining(),
      signal: controller.signal,
    });
    status = comparison.matched ? "passed" : "failed";
    reason = comparison.matched
      ? "within_fixed_tolerance"
      : "prediction_mismatch";
    await predictionDeliveryV5(root);
  } catch (error) {
    reason = String(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const report = {
    schema_version: 5,
    status,
    kind:
      mode === "predict"
        ? "prediction_reproduction"
        : "selected_pipeline_refit",
    source_run: resolve(root),
    source_frozen_id: sourceIdentity,
    directory,
    reason,
    result,
    refit,
    comparison,
    tolerance: PREDICTION_TOLERANCE,
    source_model_reused: mode === "predict",
    elapsed_ms: performance.now() - begin,
    execution_confirmed:
      (!refitDispatched || refit !== null) &&
      (!predictionDispatched || result?.execution_confirmed === true) &&
      refit?.fit?.execution_confirmed !== false,
    calls: {
      models: 0,
      fits: refit ? (refit.fit ? 1 : 0) : refitDispatched ? null : 0,
      predictions:
        result?.calls.predictions ?? (predictionDispatched ? null : 0),
    },
    tokens: "not_applicable",
  };
  await writeFile(
    join(directory, "reproduction.json"),
    JSON.stringify(report),
    { flag: "wx", mode: 0o444 },
  );
  return report;
}

export async function scoreDeliveryV5(
  root: string,
  labelsRoot: string,
  labelsFile: string,
  outRoot: string,
) {
  const begin = performance.now(),
    directory = resolve(outRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  let score: ScoreV2 | null = null,
    error: string | null = null,
    source: Awaited<ReturnType<typeof predictionDeliveryV5>> | null = null,
    labels: ScoringFileV2 | null = null;
  try {
    source = await predictionDeliveryV5(root);
    labels = {
      ...(await describeFile(labelsRoot, labelsFile)),
      path: await regular(labelsRoot, labelsFile),
    };
    const dataset = source.frozen.dataset,
      p = dataset.protocol;
    if (
      dataset.evaluator.labels &&
      (labels.sha256 !== dataset.evaluator.labels.sha256 ||
        labels.bytes !== dataset.evaluator.labels.bytes)
    )
      throw new Error("Frozen external labels identity mismatch");
    const evaluation_id = sha256(
      Buffer.from(
        canonicalJson({
          protocol_sha256: p.protocol_sha256,
          dataset_sha256: dataset.dataset_sha256,
          partition: "test",
          expected_sha256: source.expected.sha256,
          labels_sha256: labels.sha256,
        }),
      ),
    );
    await validatePredictionFilesV2({
      root: directory,
      protocol: p,
      expected: source.expected,
      predictions: source.predictions,
      limits: dataset.limits,
      timeout_ms: 30000,
    });
    const scored = await scoreFilesV2({
      root: directory,
      protocol: p,
      evaluation_id,
      partition: "test",
      labels,
      predictions: source.predictions,
      limits: dataset.limits,
      timeout_ms: 30000,
    });
    score = scored.score;
    error = scored.error;
  } catch (failure) {
    error = String(failure);
  }
  const report = {
    schema_version: 5,
    kind: "frozen_test_score",
    status: score ? "completed" : "failed",
    source_run: resolve(root),
    source_frozen_id: source?.frozen.frozen_id ?? null,
    protocol: source?.frozen.dataset.protocol ?? null,
    score,
    error,
    labels,
    prediction: source?.predictions ?? null,
    expected: source?.expected ?? null,
    elapsed_ms: performance.now() - begin,
    calls: { models: 0, fits: 0, predictions: 0 },
    tokens: "not_applicable",
  };
  await writeFile(join(directory, "score.json"), JSON.stringify(report), {
    flag: "wx",
    mode: 0o444,
  });
  return { directory, ...report };
}
