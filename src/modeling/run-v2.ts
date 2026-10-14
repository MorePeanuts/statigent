import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { regular, verifyFiles } from "../evaluation/files";
import { dockerCommand } from "../execution/docker";
import { obj, str } from "../models/validation";
import { MODELING_PROMPT_V2_VERSION, modelingPrompt } from "./actions";
import { validateBenchmarkModelingTask } from "./config";
import { parseCsv } from "./data";
import { loadDatasetV3 } from "./dataset-v3";
import { analyzeV2 } from "./eda-v2";
import { runExperimentV2 } from "./experiments-v2";
import { freezeModel, predictFrozenModel } from "./frozen-model";
import { createBasicProfileV2 } from "./profile-v2";
import type { ModelingOptions } from "./run";
import { runModelingSession } from "./run-session";
import { betterV2 } from "./score-v2";
import { selectFileV2 } from "./table-ops";
import { createValidationPlanV2, loadSearchMembersV2 } from "./validation-v2";

export async function stage4Image(image: string, timeout: number) {
  const raw: unknown = JSON.parse(
    await dockerCommand(
      ["image", "inspect", image],
      Math.max(1, Math.min(10000, timeout)),
    ),
  );
  if (!Array.isArray(raw) || raw.length !== 1)
    throw new Error("Invalid image inspection");
  const info = obj(raw[0]),
    labels = obj(obj(info.Config).Labels);
  if (labels["org.statigent.modeling-stage"] !== "4")
    throw new Error("Image does not support modeling stage 4");
  const id = str(info.Id, "image ID");
  if (!/^sha256:[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid immutable image ID");
  return {
    id,
    platform: `${str(info.Os, "image OS")}/${str(info.Architecture, "image architecture")}`,
  };
}
export interface BenchmarkRuntimeOptions {
  experiment?: typeof runExperimentV2;
  analysis?: typeof analyzeV2;
  prepareProfile?: typeof createBasicProfileV2;
  imagePreflight?: typeof stage4Image;
  freeze?: typeof freezeModel;
  predict?: typeof predictFrozenModel;
  inputAccess?: "complete" | "training";
  /** 受信调度器在模型冻结后才发布本次预测特征，不能修改搜索输入。 */
  publishPrediction?: () => Promise<void>;
}
export async function runBenchmarkModeling(
  o: ModelingOptions & { start: number },
) {
  const requested = validateBenchmarkModelingTask(o.task),
    hooks = o.benchmark ?? {};
  const remaining = () =>
    Math.max(
      0,
      Math.floor(
        requested.budget.task_timeout_ms - (performance.now() - o.start),
      ),
    );
  if (o.signal?.aborted || remaining() <= 0)
    throw new Error("Modeling preparation cancelled/deadline");
  const image = await (hooks.imagePreflight ?? stage4Image)(
    requested.image,
    remaining(),
  );
  const task = { ...requested, image: image.id };
  const { root: sourceRoot, dataset } = await loadDatasetV3(task.dataset_root, {
    access: hooks.inputAccess ?? "complete",
    signal: o.signal,
    timeout_ms: remaining(),
  });
  if (task.delivery_mode === "fit_predict" && !dataset.prediction)
    throw new Error("fit_predict requires a frozen prediction partition");
  const preparationRoot = resolve(o.runRoot, "preparations", randomUUID());
  await mkdir(preparationRoot, { recursive: true });
  const p = dataset.protocol,
    members = await loadSearchMembersV2(sourceRoot, dataset);
  const labelsFile = await selectFileV2({
    root: preparationRoot,
    source: {
      ...dataset.training,
      path: resolve(sourceRoot, dataset.training.path),
    },
    columns: [p.id_column, ...p.targets.map((t) => t.name)],
    members: null,
    limits: dataset.limits,
    signal: o.signal,
    timeout_ms: remaining(),
  });
  // 控制层仅持有 ID 和目标，不复制特征表；为解析及多份成员映射保留保守余量。
  if (labelsFile.file.bytes * 16 > dataset.limits.max_memory_bytes)
    throw new Error("Validation metadata memory limit");
  const labels = parseCsv(await readFile(labelsFile.file.path, "utf8"));
  const validationPlan = createValidationPlanV2(
    dataset,
    labels,
    members,
    task.confirmation.mode,
  );
  await verifyFiles(sourceRoot, dataset.public_context);
  const publicContext = await Promise.all(
    dataset.public_context.map(async (ref) => ({
      path: ref.path,
      sha256: ref.sha256,
      text: await readFile(await regular(sourceRoot, ref.path), "utf8"),
    })),
  );
  const preparation = {
    dataset_sha256: dataset.dataset_sha256,
    directory: preparationRoot,
    elapsed_ms: performance.now() - o.start,
    requested_image: requested.image,
    effective_image: image,
    validation_labels: labelsFile.file,
  };
  await writeFile(
    join(preparationRoot, "preparation.json"),
    JSON.stringify(preparation),
    { flag: "wx" },
  );
  return runModelingSession(
    { ...o, task, start: o.start },
    {
      completion:
        task.delivery_mode === "fit_only" ? "model_frozen" : "completed",
      preparation,
      dataset,
      protocol: p,
      validationPlan,
      promptVersion: MODELING_PROMPT_V2_VERSION,
      prompt: modelingPrompt(task.method, 2),
      promptProtocol: {
        ...p,
        training_rows: members.train.length,
        validation_rows: members.validation.length,
        feature_schema: dataset.feature_schema,
        public_context: publicContext,
      },
      initialQuestion: `Examine allowed training data for ${p.kind} prediction of all targets ${p.targets.map((t) => t.name).join(", ")}. Which missingness, distributions or data-quality issues should inform the initial pipeline?`,
      prepareProfile: (options) =>
        (hooks.prepareProfile ?? createBasicProfileV2)({
          ...options,
          sourceRoot,
          dataset,
          members,
        }),
      execute: (options) =>
        (hooks.experiment ?? runExperimentV2)({
          ...options,
          sourceRoot,
          dataset,
          fitOnly: options.evaluation.phase === "final",
        }),
      analyze: (options) =>
        (hooks.analysis ?? analyzeV2)({
          ...options,
          sourceRoot,
          dataset,
          members,
        }),
      better: betterV2,
      deliver: async (options) => {
        const frozen = await (hooks.freeze ?? freezeModel)({
          root: options.root,
          sourceRoot,
          dataset,
          task,
          selected: options.selected,
          final: options.final,
          plan: validationPlan,
        });
        await options.onFrozen(frozen);
        let prediction: Awaited<ReturnType<typeof predictFrozenModel>> | null =
          null;
        if (task.delivery_mode === "fit_predict") {
          if (!dataset.prediction)
            throw new Error("Missing prediction partition");
          options.signal.throwIfAborted();
          await hooks.publishPrediction?.();
          options.signal.throwIfAborted();
          prediction = await (hooks.predict ?? predictFrozenModel)({
            frozenRoot: options.root,
            runRoot: join(options.root, "predictions"),
            features: {
              ...dataset.prediction,
              path: resolve(sourceRoot, dataset.prediction.path),
            },
            timeout_ms: options.remaining(),
            signal: options.signal,
            onStage: options.onPredictionStage,
          });
          await options.onPredictionResult(prediction);
          if (prediction.status !== "completed")
            throw new Error(`frozen_prediction_failed:${prediction.reason}`);
        }
        const delivery = {
          schema_version: 5,
          status: prediction ? "completed" : "pending_prediction",
          frozen,
          prediction,
          search_best_experiment_id: options.selection.searchBest.id,
          selected_experiment_id: options.selected.id,
          confirmation: options.selection.confirmation,
          validation_plan: validationPlan,
        };
        await mkdir(join(options.root, "delivery"));
        await writeFile(
          join(options.root, "delivery/delivery.json"),
          JSON.stringify(delivery),
          { flag: "wx", mode: 0o444 },
        );
        return delivery;
      },
    },
  );
}
