import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ledger } from "../../modeling/budget";
import {
  MODELING_BUDGET,
  validateBenchmarkModelingTask,
} from "../../modeling/config";
import { parseDatasetV3 } from "../../modeling/dataset-v3";
import { predictionDeliveryV5 } from "../../modeling/delivery-v2";
import {
  DETERMINISTIC_PROFILE,
  DeterministicModelingClient,
  deterministicPipeline,
} from "../../modeling/deterministic";
import { prepareExecutionSeed } from "../../modeling/execution-seed";
import { inspectModeling } from "../../modeling/records";
import { type ModelingOptions, runModeling } from "../../modeling/run";
import { stage4Image } from "../../modeling/run-v2";
import { resolveCredential } from "../../models/config";
import { keys, obj } from "../../models/validation";
import { nativeModelingPublication } from "../benchmarks/modeling/publication";
import {
  type AgentAdapter,
  emptyUsage,
  type Invocation,
  literal,
  type Submission,
  type Usage,
  validateInvocation,
  validateSubmission,
  validateUsage,
} from "../contracts";
import { describeFile, regular } from "../files";

export function modelingOptions(value: unknown) {
  const x = obj(value);
  keys(x, [
    "image",
    "method",
    "confirmation",
    "resource_version",
    "budget",
    "limits",
  ]);
  const supplied = obj(x.budget ?? {});
  keys(
    supplied,
    Object.keys(MODELING_BUDGET).filter(
      (k) => !["model_attempts", "total_tokens", "task_timeout_ms"].includes(k),
    ),
  );
  const parsed = validateBenchmarkModelingTask({
    schema_version: 4,
    delivery_mode: "fit_predict",
    goal: "Validate adapter configuration",
    dataset_root: ".",
    model_profile: "adapter-validation",
    image: x.image,
    method: x.method,
    confirmation: x.confirmation,
    resource_version: x.resource_version,
    budget: supplied,
    limits: x.limits,
  });
  const {
    model_attempts: _a,
    total_tokens: _t,
    task_timeout_ms: _m,
    ...budget
  } = parsed.budget;
  return {
    image: parsed.image,
    method: parsed.method,
    confirmation: parsed.confirmation,
    resource_version: parsed.resource_version,
    budget,
    limits: parsed.limits,
  };
}

/** inspect 已检查父账与角色/子账一致；这里只取一次父账，不能再次相加子 EDA。 */
export function modelingParentUsage(
  value: unknown,
  deterministic = false,
): Usage {
  const total = ledger(obj(value).tokens);
  if (deterministic) {
    if (total.status !== "known" || total.total_tokens !== 0)
      throw new Error("Deterministic execution has unexpected model usage");
    return emptyUsage("not_applicable");
  }
  const unknown = Math.max(
    total.unknown_attempts,
    total.status === "unknown" ? 1 : 0,
  );
  return validateUsage({
    source: unknown ? "unknown" : "measured",
    attempts: Math.max(total.attempts, unknown),
    input_tokens: total.input_tokens,
    output_tokens: total.output_tokens,
    total_tokens: total.total_tokens,
    unknown_attempts: unknown,
    currency_cost: "not_computed",
  });
}

export async function deliverModelingPredictions(
  i: Invocation,
  directory: string,
) {
  if (i.task.output.kind !== "predictions")
    throw new Error("Prediction output required");
  const source = await predictionDeliveryV5(directory),
    output = i.task.output;
  if (!i.phase_roots) throw new Error("Missing phase inputs");
  const original = parseDatasetV3(
    JSON.parse(
      await readFile(
        await regular(i.phase_roots.search, output.input_manifest),
        "utf8",
      ),
    ),
  );
  const actual = source.frozen.dataset;
  if (
    actual.seed !== i.seed ||
    ![
      "training",
      "prediction",
      "feature_schema",
      "evaluator",
      "public_context",
    ].every((key) => isDeepStrictEqual(obj(actual)[key], obj(original)[key]))
  )
    throw new Error("Seeded execution changed frozen outer data");
  if (
    (actual.dataset_sha256 !== i.task.version &&
      actual.provenance.execution_seed_source !== i.task.version) ||
    source.frozen.dataset.protocol.protocol_sha256 !==
      output.protocol.protocol_sha256 ||
    source.predictions.bytes > output.limits.max_file_bytes
  )
    throw new Error("Native prediction identity/limit mismatch");
  for (const path of [output.prediction_file, output.manifest_file])
    await mkdir(dirname(join(i.deliverables_root, path)), { recursive: true });
  await copyFile(
    source.predictions.path,
    join(i.deliverables_root, output.prediction_file),
    constants.COPYFILE_EXCL,
  );
  const prediction = await describeFile(
    i.deliverables_root,
    output.prediction_file,
  );
  if (prediction.sha256 !== source.predictions.sha256)
    throw new Error("Prediction copy integrity mismatch");
  const manifest = {
    schema_version: 1,
    kind: "modeling-predictions",
    task_id: i.task.id,
    task_version: i.task.version,
    protocol: output.protocol,
    seed: i.seed,
    dataset_sha256: source.frozen.dataset.dataset_sha256,
    expected_features: source.frozen.dataset.prediction,
    predictions: prediction,
    export: null,
    native_model: {
      run_id: source.parent.run_id,
      frozen_id: source.frozen.frozen_id,
      sha256: source.frozen.model.sha256,
      bytes: source.frozen.model.bytes,
    },
    execution_preparation:
      actual.dataset_sha256 === i.task.version
        ? null
        : JSON.parse(
            await readFile(
              await regular(
                source.frozen.task.dataset_root,
                "seed-preparation.json",
              ),
              "utf8",
            ),
          ),
    workflow: {
      search_end: source.parent.search_end,
      delivery_status: "completed",
      prediction_status: "completed",
      reproduction_status: "not_run",
      search_best_experiment_id: source.delivery.search_best_experiment_id,
      selected_experiment_id: source.delivery.selected_experiment_id,
      confirmation: source.delivery.confirmation,
      usage: source.parent.usage,
      wall_ms: source.parent.wall_ms,
    },
  };
  await writeFile(
    join(i.deliverables_root, output.manifest_file),
    JSON.stringify(manifest),
    { flag: "wx" },
  );
}

export function modelingAdapter(
  dependencies: {
    deterministic?: boolean;
    run?: typeof runModeling;
    inspect?: (directory: string) => Promise<{
      manifest: { usage: unknown };
      unconfirmed_children: readonly unknown[];
      unconfirmed_experiments: readonly unknown[];
    }>;
    publication?: typeof nativeModelingPublication;
    deliver?: typeof deliverModelingPredictions;
    image?: typeof stage4Image;
    overrides?: Partial<ModelingOptions>;
  } = {},
): AgentAdapter {
  const deterministic = dependencies.deterministic === true;
  const options = (value: unknown) => {
    const result = modelingOptions(value);
    if (deterministic && result.method !== "no_eda")
      throw new Error("Deterministic verification uses no_eda");
    return result;
  };
  return {
    id: deterministic ? "deterministic-modeling" : "statigent-modeling",
    version: "1",
    capabilities: {
      schema_version: 3,
      outputs: ["predictions"],
      phase_isolation: true,
      trajectory: "none",
      model: deterministic ? "none" : "configurable",
      seed: "execution",
      isolation: "docker",
      model_budget: !deterministic,
      usage: deterministic ? "not_applicable" : "measured",
    },
    options,
    async preview(config) {
      options(config.options);
    },
    async preflight(config) {
      const settings = options(config.options);
      if (!deterministic && !dependencies.overrides?.client) {
        if (!config.model) throw new Error("Model profile required");
        resolveCredential(config.model);
      }
      const image = await (dependencies.image ?? stage4Image)(
        settings.image,
        10000,
      );
      return {
        image_id: image.id,
        platform: image.platform,
        capabilities: this.capabilities,
        native_options: settings,
        accounting: "native-parent-only",
        execution_mode: deterministic ? "deterministic" : "live",
        unified_budget_source: "invocation.effective_budget",
      };
    },
    async run(value, signal) {
      const i = validateInvocation(value),
        started = performance.now();
      const selected = deterministic ? DETERMINISTIC_PROFILE : i.config.model;
      if (!selected) throw new Error("Model profile required");
      const result: Submission = {
        schema_version: 3,
        unit_id: i.unit_id,
        status: "failed",
        answer_text: "",
        reason: "not_started",
        deliverables: [],
        trajectory: null,
        native_run: null,
        usage: deterministic
          ? emptyUsage("not_applicable")
          : { ...emptyUsage("not_applicable"), source: "measured" },
        cleanup_error: null,
        record_error: false,
      };
      let dispatched = false;
      let settled = false;
      try {
        const settings = options(i.config.options);
        if (
          !deterministic &&
          (i.budget.model_attempts === null || i.budget.total_tokens === null)
        )
          throw new Error("Effective parent model budget required");
        const taskBudget = {
          ...settings.budget,
          task_timeout_ms: i.budget.timeout_ms,
          model_attempts: i.budget.model_attempts ?? 2,
          total_tokens: i.budget.total_tokens ?? MODELING_BUDGET.total_tokens,
        };
        // 先验证静态预留，避免预算不足时启动数据准备或模型调用。
        validateBenchmarkModelingTask({
          ...settings,
          schema_version: 4,
          delivery_mode: "fit_predict",
          goal: i.task.goal,
          dataset_root: i.input_root,
          model_profile: selected.id,
          budget: taskBudget,
        });
        const publication = await (
          dependencies.publication ?? nativeModelingPublication
        )(i);
        const execution =
          i.seed === publication.dataset.seed
            ? publication
            : await prepareExecutionSeed({
                root: i.run_root,
                sourceRoot: publication.root,
                dataset: publication.dataset,
                seed: i.seed,
                timeout_ms: Math.floor(
                  i.budget.timeout_ms - (performance.now() - started),
                ),
                signal,
              });
        const task = validateBenchmarkModelingTask({
          ...settings,
          schema_version: 4,
          delivery_mode: "fit_predict",
          goal: i.task.goal,
          dataset_root: execution.root,
          model_profile: selected.id,
          budget: {
            ...taskBudget,
            task_timeout_ms: Math.floor(
              i.budget.timeout_ms - (performance.now() - started),
            ),
          },
        });
        signal?.throwIfAborted();
        dispatched = true;
        const native = await (dependencies.run ?? runModeling)({
          ...dependencies.overrides,
          task,
          profile: selected,
          edaProfile: selected,
          ...(deterministic
            ? {
                client: new DeterministicModelingClient(
                  deterministicPipeline(execution.dataset.protocol),
                ),
              }
            : {}),
          benchmark: {
            ...dependencies.overrides?.benchmark,
            inputAccess: "training",
            publishPrediction: () =>
              publication.publishPrediction(execution.root),
          },
          runRoot: i.run_root,
          signal,
        });
        result.native_run = { id: native.run_id, directory: native.directory };
        result.status =
          native.status === "model_frozen"
            ? "failed"
            : literal(native.status, [
                "completed",
                "failed",
                "timed_out",
                "cancelled",
                "budget_exhausted",
              ]);
        result.reason = native.reason;
        result.record_error = native.record_error;
        const view = await (dependencies.inspect ?? inspectModeling)(
          native.directory,
        );
        result.usage = modelingParentUsage(view.manifest.usage, deterministic);
        settled = true;
        if (
          view.unconfirmed_children.length ||
          view.unconfirmed_experiments.length ||
          native.reason.includes("cleanup")
        )
          result.cleanup_error = "native_execution_unconfirmed";
        if (native.status === "completed") {
          await (dependencies.deliver ?? deliverModelingPredictions)(
            i,
            native.directory,
          );
          result.answer_text = "Frozen predictions delivered";
        }
      } catch (error) {
        result.status = signal?.aborted ? "cancelled" : "failed";
        result.reason = String(error);
        if (dispatched && !result.native_run)
          result.usage = deterministic
            ? emptyUsage("not_applicable")
            : emptyUsage("unknown");
        if (
          dispatched &&
          !settled &&
          result.native_run &&
          result.usage.source === "measured" &&
          !result.usage.attempts
        )
          result.usage = emptyUsage("unknown");
        if (dispatched && !settled) result.record_error = true;
      }
      return validateSubmission(result, i.unit_id, {
        frozen: false,
        output: i.task.output,
      });
    },
  };
}
