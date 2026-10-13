import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile, regular, verifyFiles } from "../evaluation/files";
import { dockerCommand } from "../execution/docker";
import { obj, str } from "../models/validation";
import { readManifest, writeJson } from "../records/store";
import { type ModelingTask, validateModelingTask } from "./config";
import {
  type Dataset,
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
export async function deliver(
  root: string,
  task: ModelingTask,
  selected: Experiment,
  final: Experiment,
  dataset: Dataset,
) {
  if (
    final.status !== "completed" ||
    !final.final ||
    !final.fit ||
    !final.predict ||
    final.code_sha256 !== selected.code_sha256
  )
    throw new Error("Invalid final delivery");
  const dir = join(root, "delivery");
  await mkdir(dir);
  const values: Record<string, string | Buffer> = {
    "candidate.py": final.code,
    "model.joblib": await stageBytes(final.fit),
    "predictions.csv": await stageBytes(final.predict),
    "train.py": stageEntrypoint("fit"),
    "predict.py": stageEntrypoint("predict"),
    "README.md":
      "# Model delivery\n\nUse the recorded container image and `bun run modeling reproduce --run PARENT_RUN` for prediction. `--mode refit` re-executes the frozen pipeline on the allowed training data; it does not replay the agent search. train.py/predict.py run via uv inside this image with stage-specific inputs at /input. Do not load model.joblib on the host.\n",
  };
  for (const [p, v] of Object.entries(values))
    await writeFile(join(dir, p), v, { flag: "wx", mode: 0o444 });
  const native = await readManifest(final.fit.directory);
  const manifest = {
    schema_version: 1,
    source_experiment: selected.id,
    dataset,
    model_environment: native.environment,
    code_version: native.code,
    validation_rmse: selected.rmse,
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
    parent.schema_version !== 1 ||
    parent.kind !== "modeling" ||
    parent.status !== "completed"
  )
    throw new Error("Delivery is not frozen and completed");
  const directory = join(root, "delivery");
  const manifest = obj(
    JSON.parse(
      await readFile(await regular(directory, "delivery.json"), "utf8"),
    ),
  );
  if (
    manifest.schema_version !== 1 ||
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
      "README.md",
    ])
  )
    throw new Error("Invalid delivery allowlist");
  await verifyFiles(directory, files);
  return {
    directory,
    manifest,
    task: validateModelingTask(manifest.task),
    dataset: validateDataset(obj(parent.config).dataset),
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
          entrypoints,
        });
  const stage = "final" in result ? result.predict : result;
  let passed = false,
    reason = result.reason;
  if (result.status === "completed" && stage) {
    const ids = rowIds(data.test, data.dataset.id_column);
    const expected = predictionValues(
        await tableFile(f.directory, "predictions.csv"),
        ids,
        data.dataset.id_column,
      ),
      actual = predictionValues(
        parseCsv((await stageBytes(stage)).toString()),
        ids,
        data.dataset.id_column,
      );
    passed = actual.every(
      (v, i) =>
        Math.abs(v - (expected[i] ?? NaN)) <=
        1e-8 + 1e-6 * Math.abs(expected[i] ?? NaN),
    );
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
    labels: await describeFile(labelsRoot, labelsFile),
    prediction: f.files.find((x) => x.path === "predictions.csv"),
    tokens: "not_applicable",
  };
  await writeJson(join(dir, "score.json"), report);
  return { directory: dir, ...report };
}
