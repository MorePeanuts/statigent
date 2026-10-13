import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describeFile, regular, verifyFiles } from "../evaluation/files";
import { integer, keys, obj, str } from "../models/validation";
import { readArtifact, safeRelativePath, sha256 } from "../records/store";
import { type ModelingTask, validateBenchmarkModelingTask } from "./config";
import { type DatasetV3, parseDatasetV3 } from "./dataset-v3";
import { type Experiment, runStage, type StageResult } from "./experiments";
import { stageFile } from "./experiments-v2";
import { validatePredictionFilesV2 } from "./predictions-v2";
import { canonicalJson, validateProtocolV2 } from "./protocol-v2";
import { type ScoreV2, validateScoreV2 } from "./score-v2";
import type { ScoringFileV2 } from "./scoring-v2";
import type { ValidationPlan } from "./validation";

function digest(v: unknown) {
  const s = str(v, "SHA256");
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error("Invalid SHA256");
  return s;
}
function file(v: unknown) {
  const f = obj(v);
  keys(f, ["path", "bytes", "sha256"]);
  return {
    path: safeRelativePath(str(f.path, "path")),
    bytes: integer(f.bytes, "bytes", 0),
    sha256: digest(f.sha256),
  };
}
export function parseFrozenModel(value: unknown) {
  const x = obj(value);
  keys(x, [
    "version",
    "kind",
    "created_at",
    "run_id",
    "dataset",
    "task",
    "image",
    "selected_experiment_id",
    "final_experiment_id",
    "model_seed",
    "code",
    "model",
    "metadata",
    "feature_schema",
    "validation_score",
    "search_evaluation_id",
    "frozen_id",
  ]);
  const { frozen_id, ...content } = x;
  if (
    x.version !== 1 ||
    x.kind !== "frozen-model" ||
    digest(frozen_id) !== sha256(Buffer.from(canonicalJson(content)))
  )
    throw new Error("Frozen model identity mismatch");
  const dataset = parseDatasetV3(x.dataset),
    task = validateBenchmarkModelingTask(x.task),
    image = obj(x.image);
  keys(image, ["id", "platform"]);
  const imageId = str(image.id, "image ID");
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error("Frozen image must be pinned");
  const modelSeed = integer(x.model_seed, "model seed", 0);
  if (modelSeed !== dataset.seed)
    throw new Error("Frozen final model seed mismatch");
  const refs = {
    code: file(x.code),
    model: file(x.model),
    metadata: file(x.metadata),
    feature_schema: file(x.feature_schema),
  };
  if (
    refs.code.path !== "frozen/candidate.py" ||
    refs.feature_schema.path !== "frozen/features.json" ||
    refs.feature_schema.sha256 !== dataset.feature_schema.sha256 ||
    refs.feature_schema.bytes !== dataset.feature_schema.bytes ||
    refs.model.bytes > task.limits.max_artifact_bytes ||
    refs.code.bytes > task.limits.max_code_bytes ||
    refs.metadata.bytes > dataset.limits.max_file_bytes ||
    !refs.model.path.startsWith("stages/") ||
    !refs.metadata.path.startsWith("stages/")
  )
    throw new Error("Frozen file contract mismatch");
  const createdAt = str(x.created_at, "created at");
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new Error("Invalid frozen timestamp");
  return {
    version: 1 as const,
    kind: "frozen-model" as const,
    created_at: createdAt,
    run_id: str(x.run_id, "run ID"),
    dataset,
    task,
    image: { id: imageId, platform: str(image.platform, "platform") },
    selected_experiment_id: str(
      x.selected_experiment_id,
      "selected experiment",
    ),
    final_experiment_id: str(x.final_experiment_id, "final experiment"),
    model_seed: modelSeed,
    ...refs,
    search_evaluation_id: digest(x.search_evaluation_id),
    validation_score: validateScoreV2(x.validation_score, dataset.protocol, {
      evaluation_id: digest(x.search_evaluation_id),
      partition: "search-validation",
    }),
    frozen_id: digest(frozen_id),
  };
}
export type FrozenModel = ReturnType<typeof parseFrozenModel>;

export async function loadFrozenModel(root: string): Promise<FrozenModel> {
  const path = await regular(root, "frozen/model.json");
  if ((await stat(path)).size > 16 * 1024 * 1024)
    throw new Error("Frozen manifest file limit");
  const manifest = parseFrozenModel(JSON.parse(await readFile(path, "utf8")));
  await verifyFiles(root, [
    manifest.code,
    manifest.model,
    manifest.metadata,
    manifest.feature_schema,
  ]);
  const metadata = obj(
    JSON.parse(
      await readFile(await regular(root, manifest.metadata.path), "utf8"),
    ),
  );
  keys(metadata, ["schema_version", "protocol", "feature_schema_sha256"]);
  if (
    metadata.schema_version !== 2 ||
    validateProtocolV2(metadata.protocol).protocol_sha256 !==
      manifest.dataset.protocol.protocol_sha256 ||
    metadata.feature_schema_sha256 !== manifest.feature_schema.sha256
  )
    throw new Error("Frozen model metadata mismatch");
  return manifest;
}

export async function freezeModel(o: {
  root: string;
  sourceRoot: string;
  dataset: DatasetV3;
  task: ModelingTask;
  selected: Experiment<ScoreV2>;
  final: Experiment<ScoreV2>;
  plan: ValidationPlan;
}) {
  const task = validateBenchmarkModelingTask(o.task),
    final = o.final;
  if (
    final.status !== "completed" ||
    final.reason !== "model_frozen" ||
    !final.final ||
    !final.fit?.output ||
    !final.fit.metadata ||
    final.fit.stage_version !== 4 ||
    final.predict !== null ||
    final.score !== null ||
    final.code_sha256 !== o.selected.code_sha256 ||
    final.code_sha256 !== sha256(Buffer.from(final.code)) ||
    final.evaluation?.evaluation_id !== o.plan.final.evaluation_id ||
    final.source_search_experiment_id !== o.selected.id
  )
    throw new Error("Invalid frozen final experiment");
  validateScoreV2(o.selected.score, o.dataset.protocol, {
    evaluation_id: o.plan.search.evaluation_id,
    partition: "search-validation",
  });
  const root = resolve(o.root),
    dir = join(root, "frozen");
  await mkdir(dir);
  const model = {
    ...final.fit.output,
    path: safeRelativePath(
      relative(root, resolve(final.fit.directory, final.fit.output.path)),
    ),
  };
  const metadata = {
    ...final.fit.metadata,
    path: safeRelativePath(
      relative(root, resolve(final.fit.directory, final.fit.metadata.path)),
    ),
  };
  await verifyFiles(root, [model, metadata]);
  await writeFile(join(dir, "candidate.py"), final.code, {
    flag: "wx",
    mode: 0o444,
  });
  await verifyFiles(o.sourceRoot, [o.dataset.feature_schema]);
  await copyFile(
    await regular(o.sourceRoot, o.dataset.feature_schema.path),
    join(dir, "features.json"),
    constants.COPYFILE_EXCL,
  );
  await chmod(join(dir, "features.json"), 0o444);
  const content = {
    version: 1,
    kind: "frozen-model",
    created_at: new Date().toISOString(),
    run_id: basename(root),
    dataset: o.dataset,
    task,
    image: { id: final.fit.image.id, platform: final.fit.image.platform },
    selected_experiment_id: o.selected.id,
    final_experiment_id: final.id,
    model_seed: o.plan.final.model_seed,
    code: await describeFile(root, "frozen/candidate.py"),
    model,
    metadata,
    feature_schema: await describeFile(root, "frozen/features.json"),
    validation_score: o.selected.score,
    search_evaluation_id: o.plan.search.evaluation_id,
  };
  const manifest = parseFrozenModel({
    ...content,
    frozen_id: sha256(Buffer.from(canonicalJson(content))),
  });
  await writeFile(join(dir, "model.json"), JSON.stringify(manifest), {
    flag: "wx",
    mode: 0o444,
  });
  return loadFrozenModel(root);
}

export async function predictFrozenModel(o: {
  frozenRoot: string;
  runRoot: string;
  features: ScoringFileV2;
  timeout_ms: number;
  signal?: AbortSignal;
  onStage?: (id: string) => Promise<void>;
  stage?: typeof runStage;
}) {
  const began = performance.now(),
    run_id = randomUUID(),
    root = resolve(o.runRoot, run_id);
  integer(o.timeout_ms, "prediction timeout");
  await mkdir(root, { recursive: true });
  const controller = new AbortController(),
    signal = o.signal
      ? AbortSignal.any([o.signal, controller.signal])
      : controller.signal;
  const timer = setTimeout(() => controller.abort(), o.timeout_ms);
  let frozen: FrozenModel | null = null,
    stage: StageResult | null = null,
    output: ScoringFileV2 | null = null,
    status = "failed",
    reason = "not_started";
  let dispatched = false;
  const remaining = () =>
    Math.max(0, Math.floor(o.timeout_ms - (performance.now() - began)));
  try {
    if (signal.aborted || remaining() <= 0)
      throw new Error("Prediction cancelled/deadline");
    frozen = await loadFrozenModel(resolve(o.frozenRoot));
    if (signal.aborted || remaining() <= 0)
      throw new Error("Prediction cancelled/deadline");
    const features = { ...o.features, path: resolve(o.features.path) };
    if (features.bytes > frozen.dataset.limits.max_file_bytes)
      throw new Error("Prediction input file limit");
    await verifyFiles(dirname(features.path), [
      { ...features, path: basename(features.path) },
    ]);
    await writeFile(
      join(root, "request.json"),
      JSON.stringify({
        version: 1,
        run_id,
        frozen_id: frozen.frozen_id,
        model_sha256: frozen.model.sha256,
        features,
        timeout_ms: o.timeout_ms,
      }),
      { flag: "wx" },
    );
    const modelParts = frozen.model.path.split("/");
    const model = await readArtifact(
      resolve(o.frozenRoot, ...modelParts.slice(0, 2)),
      {
        ...frozen.model,
        path: modelParts.slice(2).join("/"),
        size_bytes: frozen.model.bytes,
        complete: true,
      },
    );
    dispatched = true;
    stage = await (o.stage ?? runStage)({
      root,
      task: { ...frozen.task, image: frozen.image.id },
      dataset: frozen.dataset,
      stageVersion: 4,
      stage: "predict",
      code: await readFile(
        await regular(o.frozenRoot, frozen.code.path),
        "utf8",
      ),
      model,
      data: features,
      featureSchema: {
        ...frozen.feature_schema,
        path: resolve(o.frozenRoot, frozen.feature_schema.path),
      },
      modelSeed: frozen.model_seed,
      signal,
      remainingMs: remaining(),
      onIntent: o.onStage,
    });
    if (stage.status !== "completed") throw new Error(stage.reason);
    output = await stageFile(stage);
    await validatePredictionFilesV2({
      root,
      protocol: frozen.dataset.protocol,
      expected: features,
      predictions: output,
      limits: frozen.dataset.limits,
      signal,
      timeout_ms: remaining(),
    });
    if (signal.aborted || remaining() <= 0)
      throw new Error("Prediction cancelled/deadline");
    status = "completed";
    reason = "predictions_validated";
  } catch (error) {
    reason = String(error);
    status = o.signal?.aborted
      ? "cancelled"
      : controller.signal.aborted || remaining() <= 0
        ? "timed_out"
        : "failed";
    output = null;
  } finally {
    clearTimeout(timer);
  }
  const result = {
    version: 1,
    kind: "frozen-prediction",
    run_id,
    directory: root,
    frozen_id: frozen?.frozen_id ?? null,
    model_sha256: frozen?.model.sha256 ?? null,
    status,
    reason,
    stage,
    predictions: output,
    elapsed_ms: performance.now() - began,
    execution_confirmed: stage?.execution_confirmed ?? !dispatched,
    calls: { models: 0, fits: 0, predictions: dispatched ? 1 : 0 },
  };
  await writeFile(join(root, "prediction.json"), JSON.stringify(result), {
    flag: "wx",
    mode: 0o444,
  });
  return result;
}
