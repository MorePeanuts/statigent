import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile, regular, verifyFiles } from "../evaluation/files";
import { dockerCommand } from "../execution/docker";
import { obj, str } from "../models/validation";
import { readManifest, writeJson } from "../records/store";
import {
  type ModelingExecutionTask,
  validateFrozenModelingTask,
  validateModelingTask,
} from "./config";
import type { ConfirmationResult } from "./confirmation";
import {
  type Dataset,
  datasetProtocol,
  finite,
  loadDataset,
  parseCsv,
  rowIds,
  tableFile,
  validateDataset,
} from "./data";
import {
  type Experiment,
  predictionValues,
  rmse,
  runExperiment,
  runStage,
  stageBytes,
  stageEntrypoint,
} from "./experiments";
import { samePredictions, validatePredictions } from "./predictions";
import {
  validateModelMetadata,
  validateProtocol,
  validateScore,
} from "./protocol";
import { inspectModeling } from "./records";
import { scoreTables } from "./scoring";
import type { ValidationPlan } from "./validation";
export async function deliver(
  root: string,
  task: ModelingExecutionTask,
  selected: Experiment,
  final: Experiment,
  dataset: Dataset,
  selection?: {
    searchBest: Experiment;
    confirmation: ConfirmationResult;
    plan: ValidationPlan;
  },
) {
  if (
    final.status !== "completed" ||
    !final.final ||
    !final.fit ||
    !final.predict ||
    final.code_sha256 !== selected.code_sha256
  )
    throw new Error("Invalid final delivery");
  const protocol = datasetProtocol(dataset);
  validateScore(selected.score, protocol);
  if (!final.fit.metadata) throw new Error("Missing model metadata");
  const metadata = await readFile(
    await regular(final.fit.directory, final.fit.metadata.path),
  );
  await verifyFiles(final.fit.directory, [final.fit.metadata]);
  if (
    validateModelMetadata(JSON.parse(metadata.toString()), dataset.id_column)
      .protocol_sha256 !== protocol.protocol_sha256
  )
    throw new Error("Model metadata mismatch");
  const dir = join(root, "delivery");
  await mkdir(dir);
  const values: Record<string, string | Buffer> = {
    "candidate.py": final.code,
    "model.joblib": await stageBytes(final.fit),
    "predictions.csv": await stageBytes(final.predict),
    "train.py": stageEntrypoint("fit"),
    "predict.py": stageEntrypoint("predict"),
    "model-metadata.json": metadata,
    "README.md":
      "# Model delivery\n\nUse the recorded container image and `bun run modeling reproduce --run PARENT_RUN` for prediction. `--mode refit` re-executes the frozen pipeline on the allowed training data; it does not replay the agent search. train.py/predict.py run via uv inside this image with stage-specific inputs at /input. Do not load model.joblib on the host.\n",
  };
  for (const [p, v] of Object.entries(values))
    await writeFile(join(dir, p), v, { flag: "wx", mode: 0o444 });
  const native = await readManifest(final.fit.directory);
  const manifest = {
    schema_version: selection ? 3 : 2,
    stage_version: final.fit.stage_version ?? 2,
    protocol,
    source_experiment: selected.id,
    ...(selection
      ? {
          search_best_experiment_id: selection.searchBest.id,
          search_best_score: selection.searchBest.score,
          selected_experiment_id: selected.id,
          confirmation: selection.confirmation,
          validation_plan: selection.plan,
        }
      : {}),
    dataset,
    model_environment: native.environment,
    code_version: native.code,
    validation_score: selected.score,
    final_experiment: final.id,
    task,
    image: final.fit.image,
    files: await Promise.all(
      Object.keys(values).map((p) => describeFile(dir, p)),
    ),
    created_at: new Date().toISOString(),
    prediction_tolerance: { atol: 1e-8, rtol: 1e-6 },
  };
  await writeJson(join(dir, "delivery.json"), manifest);
  return manifest;
}
async function frozen(root: string) {
  const parent = obj(
    JSON.parse(await readFile(await regular(root, "modeling.json"), "utf8")),
  );
  if (
    ![1, 2, 3].includes(Number(parent.schema_version)) ||
    parent.kind !== "modeling" ||
    parent.status !== "completed"
  )
    throw new Error("Delivery is not frozen and completed");
  if (parent.schema_version === 3) await inspectModeling(root);
  const directory = join(root, "delivery");
  const manifest = obj(
    JSON.parse(
      await readFile(await regular(directory, "delivery.json"), "utf8"),
    ),
  );
  if (
    manifest.schema_version !== parent.schema_version ||
    JSON.stringify(parent.delivery) !== JSON.stringify(manifest)
  )
    throw new Error("Delivery manifest mismatch");
  if (!Array.isArray(manifest.files)) throw new Error("Invalid delivery files");
  const files = manifest.files.map((v: unknown) => {
    const f = obj(v);
    if (
      typeof f.bytes !== "number" ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes < 0 ||
      typeof f.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw new Error("Invalid file identity");
    return { path: str(f.path, "path"), bytes: f.bytes, sha256: f.sha256 };
  });
  if (
    JSON.stringify(files.map((f) => f.path)) !==
    JSON.stringify([
      "candidate.py",
      "model.joblib",
      "predictions.csv",
      "train.py",
      "predict.py",
      ...(manifest.schema_version !== 1 ? ["model-metadata.json"] : []),
      "README.md",
    ])
  )
    throw new Error("Invalid delivery allowlist");
  await verifyFiles(directory, files);
  const dataset = validateDataset(obj(parent.config).dataset);
  if (
    manifest.schema_version === 1 &&
    obj(parent.config).protocol !== undefined
  )
    throw new Error("Legacy delivery cannot contain a v2 task protocol");
  if (
    (manifest.schema_version !== 1 || manifest.dataset !== undefined) &&
    JSON.stringify(manifest.dataset) !== JSON.stringify(dataset)
  )
    throw new Error("Delivery dataset mismatch");
  if (manifest.schema_version !== 1) {
    const protocol = validateProtocol(manifest.protocol, dataset.id_column);
    if (
      protocol.protocol_sha256 !== datasetProtocol(dataset).protocol_sha256 ||
      validateProtocol(obj(parent.config).protocol, dataset.id_column)
        .protocol_sha256 !== protocol.protocol_sha256
    )
      throw new Error("Delivery protocol mismatch");
    validateScore(manifest.validation_score, protocol);
    if (
      validateModelMetadata(
        JSON.parse(
          await readFile(
            await regular(directory, "model-metadata.json"),
            "utf8",
          ),
        ),
        dataset.id_column,
      ).protocol_sha256 !== protocol.protocol_sha256
    )
      throw new Error("Delivery model metadata mismatch");
  }
  const tolerance = obj(manifest.prediction_tolerance);
  if (tolerance.atol !== 1e-8 || tolerance.rtol !== 1e-6)
    throw new Error("Invalid prediction tolerance");
  if (manifest.schema_version === 3) {
    if (!Array.isArray(parent.experiments))
      throw new Error("Missing frozen experiments");
    const experiments = parent.experiments.map(obj);
    const selected = experiments.find(
      (e) => e.id === parent.selected_experiment_id,
    );
    const best = experiments.find(
      (e) => e.id === parent.search_best_experiment_id,
    );
    const final = experiments.find((e) => e.id === manifest.final_experiment);
    if (
      !selected ||
      !best ||
      !final ||
      final.phase !== "final" ||
      final.status !== "completed" ||
      final.code_sha256 !== selected.code_sha256 ||
      files[0]?.sha256 !== selected.code_sha256 ||
      JSON.stringify(manifest.validation_score) !==
        JSON.stringify(selected.score) ||
      JSON.stringify(manifest.search_best_score) !==
        JSON.stringify(best.score) ||
      JSON.stringify(manifest.task) !== JSON.stringify(obj(parent.config).task)
    )
      throw new Error("Delivery selected pipeline metadata mismatch");
    for (const key of [
      "search_best_experiment_id",
      "selected_experiment_id",
      "confirmation",
    ])
      if (JSON.stringify(manifest[key]) !== JSON.stringify(parent[key]))
        throw new Error("Delivery selection mismatch");
    if (
      manifest.source_experiment !== manifest.selected_experiment_id ||
      JSON.stringify(manifest.validation_plan) !==
        JSON.stringify(obj(parent.config).validation_plan)
    )
      throw new Error("Delivery frozen plan mismatch");
  }
  return {
    directory,
    manifest,
    task:
      manifest.schema_version === 3
        ? validateModelingTask(manifest.task)
        : validateFrozenModelingTask(manifest.task),
    dataset,
    files,
  };
}
export async function reproduce(
  root: string,
  runRoot: string,
  mode: "predict" | "refit" = "predict",
) {
  const f = await frozen(root),
    data = await loadDataset(f.task.dataset_root),
    image = obj(f.manifest.image);
  if (JSON.stringify(data.dataset) !== JSON.stringify(f.dataset))
    throw new Error("Frozen input identity mismatch");
  const task = { ...f.task, image: str(image.id, "image ID") };
  const stageVersion = f.manifest.stage_version ?? 2;
  if (stageVersion !== 2 && stageVersion !== 3)
    throw new Error("Unsupported frozen modeling stage version");
  const images: unknown = JSON.parse(
    await dockerCommand(["image", "inspect", task.image]),
  );
  if (
    !Array.isArray(images) ||
    !images.length ||
    `${obj(images[0]).Os}/${obj(images[0]).Architecture}` !== image.platform
  )
    throw new Error("Image mismatch");
  const dir = resolve(runRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  const code = await readFile(
    await regular(f.directory, "candidate.py"),
    "utf8",
  );
  const signal = AbortSignal.timeout(task.budget.final_reserve_ms);
  const entrypoints = {
    fit: await readFile(await regular(f.directory, "train.py"), "utf8"),
    predict: await readFile(await regular(f.directory, "predict.py"), "utf8"),
  };
  const begin = performance.now();
  const remaining = () =>
    Math.max(0, task.budget.final_reserve_ms - (performance.now() - begin));
  const result =
    mode === "predict"
      ? await runStage({
          task,
          dataset: data.dataset,
          root: dir,
          stage: "predict",
          legacy: f.manifest.schema_version === 1,
          stageVersion,
          entrypoint: entrypoints.predict,
          code,
          data: data.test,
          model: await readFile(await regular(f.directory, "model.joblib")),
          signal,
          remainingMs: remaining(),
        })
      : await runExperiment({
          task,
          ...data,
          root: dir,
          code,
          signal,
          remaining,
          candidateId: "reproduce",
          final: true,
          legacy: f.manifest.schema_version === 1,
          stageVersion,
          entrypoints,
        });
  const stage = "final" in result ? result.predict : result;
  let passed = false,
    reason = result.reason;
  if (result.status === "completed" && stage) {
    const ids = rowIds(data.test, data.dataset.id_column);
    const protocol = datasetProtocol(data.dataset);
    const expected = validatePredictions(
      await tableFile(f.directory, "predictions.csv"),
      ids,
      data.dataset.id_column,
      protocol,
    );
    const actual = validatePredictions(
      parseCsv((await stageBytes(stage)).toString()),
      ids,
      data.dataset.id_column,
      protocol,
    );
    passed = samePredictions(expected, actual, 1e-8, 1e-6);
    reason = passed ? "within_fixed_tolerance" : "prediction_mismatch";
  }
  await verifyFiles(f.directory, f.files);
  const report = {
    status: passed ? "passed" : "failed",
    kind:
      mode === "predict"
        ? "prediction_reproduction"
        : "selected_pipeline_refit",
    source_run: root,
    directory: dir,
    reason,
    result,
    tokens: "not_applicable",
  };
  await writeJson(join(dir, "reproduction.json"), report);
  return report;
}
export async function scoreDelivery(
  root: string,
  labelsRoot: string,
  labelsFile: string,
  outRoot: string,
) {
  const f = await frozen(root),
    data = await loadDataset(f.task.dataset_root);
  if (JSON.stringify(data.dataset) !== JSON.stringify(f.dataset))
    throw new Error("Frozen input identity mismatch");
  const labels = await tableFile(labelsRoot, labelsFile),
    id = data.dataset.id_column,
    target = data.dataset.target;
  if (JSON.stringify(labels.columns) !== JSON.stringify([id, target]))
    throw new Error("Expected private ID/target label columns");
  const ids = rowIds(data.test, id);
  if (f.manifest.schema_version !== 1) {
    const dir = resolve(outRoot, randomUUID());
    await mkdir(dir, { recursive: true });
    const protocol = datasetProtocol(data.dataset);
    const predictions = await tableFile(f.directory, "predictions.csv");
    validatePredictions(predictions, ids, id, protocol);
    const scored = await scoreTables({
      root: dir,
      protocol,
      id,
      target,
      labels,
      predictions,
    });
    const report = {
      schema_version: 2,
      source_run: root,
      kind: "frozen_test_score",
      status: scored.score ? "completed" : "failed",
      protocol,
      score: scored.score,
      error: scored.error,
      labels: await describeFile(labelsRoot, labelsFile),
      prediction: f.files.find((x) => x.path === "predictions.csv"),
      tokens: "not_applicable",
    };
    await verifyFiles(f.directory, f.files);
    await writeJson(join(dir, "score.json"), report);
    return { directory: dir, ...report };
  }
  const predicted = predictionValues(
    await tableFile(f.directory, "predictions.csv"),
    ids,
    id,
  );
  const targets = predictionValues(
    { columns: [id, "prediction"], rows: labels.rows },
    ids,
    id,
  ).map((v) => finite(String(v)));
  const dir = resolve(outRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  const report = {
    schema_version: 1,
    source_run: root,
    kind: "frozen_test_score",
    metric: "rmse",
    direction: "minimize",
    value: rmse(predicted, targets),
    score: undefined,
    labels: await describeFile(labelsRoot, labelsFile),
    prediction: f.files.find((x) => x.path === "predictions.csv"),
    tokens: "not_applicable",
  };
  await writeJson(join(dir, "score.json"), report);
  return { directory: dir, ...report };
}
