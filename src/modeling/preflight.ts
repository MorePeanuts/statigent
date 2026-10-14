import { resolve } from "node:path";
import { keys, obj } from "../models/validation";
import {
  MODELING_PROMPT_V2_VERSION,
  MODELING_PROMPT_VERSION,
  modelingTools,
} from "./actions";
import { validateModelingTask } from "./config";
import { datasetProtocol, loadDataset } from "./data";
import { loadDatasetV3 } from "./dataset-v3";
import { contextIdentity } from "./prompt";
import { stage4Image } from "./run-v2";
import { createValidationPlan } from "./validation";
import { validationPlanFromFilesV2 } from "./validation-v2";
export const DEVELOPMENT_TASKS = {
  s3e9: "configs/modeling/dsbench-s3e9.json",
  binary: "configs/modeling/binary.json",
  multiclass: "configs/modeling/multiclass.json",
} as const;
export async function taskWithResource(value: unknown, resourceFile?: string) {
  const base = obj(value);
  if (!resourceFile) return validateModelingTask(base);
  const resource = obj(await Bun.file(resolve(resourceFile)).json());
  keys(resource, ["resource_version", "confirmation", "budget"]);
  return validateModelingTask({ ...base, ...resource });
}
export async function modelingPreflight(value: unknown, seed?: number) {
  const task = validateModelingTask(value);
  const prepared = await (async () => {
    if (task.schema_version === 4) {
      const data = await loadDatasetV3(task.dataset_root),
        dataset = data.dataset;
      if (seed !== undefined && seed !== dataset.seed)
        throw new Error(
          "Seed differs from frozen dataset; prepare a separate dataset version before running",
        );
      if (task.delivery_mode === "fit_predict" && !dataset.prediction)
        throw new Error("fit_predict requires a frozen prediction partition");
      const plan = await validationPlanFromFilesV2(
        data.root,
        dataset,
        task.confirmation.mode,
      );
      const image = await stage4Image(task.image, 10000);
      return {
        version: 2,
        protocol: dataset.protocol,
        plan,
        image,
        prompt_version: MODELING_PROMPT_V2_VERSION,
        dataset: {
          files: [
            dataset.training,
            dataset.feature_schema,
            ...(dataset.prediction ? [dataset.prediction] : []),
          ],
          split_sha256: plan.search.split.sha256,
          seed: dataset.seed,
          protocol: dataset.protocol,
          training_rows: dataset.split.train_rows,
          validation_rows: dataset.split.validation_rows,
        },
      };
    }
    const data = await loadDataset(task.dataset_root),
      protocol = datasetProtocol(data.dataset);
    if (seed !== undefined && seed !== data.dataset.seed)
      throw new Error(
        "Seed differs from frozen dataset; prepare a separate dataset version before running",
      );
    const plan = createValidationPlan(
      data.dataset,
      data.train,
      task.confirmation.mode,
    );
    return {
      version: 1,
      protocol,
      plan,
      image: null,
      prompt_version: MODELING_PROMPT_VERSION,
      dataset: {
        files: data.dataset.files,
        split_sha256: data.dataset.split.sha256,
        seed: data.dataset.seed,
        protocol,
        training_rows: data.dataset.split.train.length,
        validation_rows: data.dataset.split.validation.length,
      },
    };
  })();
  const { protocol, plan } = prepared;
  const closing =
    task.budget.final_training_attempts +
    (task.confirmation.mode === "none" ? 0 : 4);
  return {
    version: prepared.version,
    status: "ready",
    calls: { models: 0, training: 0 },
    task,
    dataset: prepared.dataset,
    ...(prepared.image ? { image: prepared.image } : {}),
    tools: modelingTools(protocol, task.method).map((t) => t.function.name),
    prompt_version: prepared.prompt_version,
    validation_plan_sha256: contextIdentity(plan).sha256,
    evaluations: [plan.search, ...plan.confirmation, plan.final].map((e) => ({
      phase: e.phase,
      evaluation_id: e.evaluation_id,
      model_seed: e.model_seed,
      split_seed: e.split_seed,
      split_sha256: e.split.sha256,
      training_rows: e.split.train.length,
      validation_rows: e.split.validation.length,
    })),
    reserve: {
      training_attempts: closing,
      confirmation_attempts: closing - task.budget.final_training_attempts,
      final_attempts: task.budget.final_training_attempts,
      closing_ms: task.budget.final_reserve_ms,
      search_attempts:
        task.budget.training_attempts === null
          ? null
          : task.budget.training_attempts - closing,
    },
    research_status: "development_only; no performance claim",
  };
}
