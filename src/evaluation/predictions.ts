import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod";
import { methodIdSchema } from "../baselines/catalog";
import { validateProtocolV2 } from "../modeling/protocol-v2";
import { integer, keys, obj } from "../models/validation";
import { safeRelativePath } from "../records/store";
import {
  hash,
  type InputFile,
  id,
  type PublicTask,
  validateUsage,
} from "./contracts";
import { regular, verifyFiles } from "./files";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const producerSchema = z
  .strictObject({
    adapter: methodIdSchema,
    method: methodIdSchema,
    version: z.string().min(1),
    config_hash: digest,
    run_id: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.adapter !== value.method)
      ctx.addIssue({
        code: "custom",
        message: "Producer method identity mismatch",
      });
  });
export const modelBundleReferenceSchema = z.strictObject({
  bundle_id: digest,
  manifest_sha256: digest,
  bytes: z.number().int().nonnegative(),
  file_count: z.number().int().positive(),
  entrypoint: z
    .string()
    .min(1)
    .refine((p) => {
      try {
        return safeRelativePath(p) === p;
      } catch {
        return false;
      }
    }),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.string().min(1),
  frozen_at: z.iso.datetime(),
});

/** 公共评分只检查预测和方法身份；不加载模型，旧 v1 保留原校验。 */
export async function readPredictionManifest(
  root: string,
  task: PublicTask,
  options: { exported?: boolean; seed?: number } = {},
) {
  const output = task.output;
  if (output.kind !== "predictions")
    throw new Error("Prediction task required");
  const path = await regular(root, output.manifest_file);
  if (
    (await stat(path)).size >
    Math.min(16 * 1024 ** 2, output.limits.max_file_bytes)
  )
    throw new Error("Prediction manifest limit");
  const x = obj(JSON.parse(await readFile(path, "utf8")));
  const external = x.schema_version === 2;
  keys(x, [
    "schema_version",
    "kind",
    "task_id",
    "task_version",
    "protocol",
    "seed",
    "dataset_sha256",
    "expected_features",
    "predictions",
    "export",
    "native_model",
    "execution_preparation",
    "workflow",
    ...(external ? ["producer", "model_bundle"] : []),
  ]);
  if (
    (x.schema_version !== 1 && !external) ||
    x.kind !== "modeling-predictions" ||
    x.task_id !== task.id ||
    x.task_version !== task.version ||
    !isDeepStrictEqual(validateProtocolV2(x.protocol), output.protocol)
  )
    throw new Error("Prediction manifest task/protocol mismatch");
  const seed = integer(x.seed, "prediction seed", 0);
  if (seed >= 2 ** 32 || (options.seed !== undefined && options.seed !== seed))
    throw new Error("Prediction seed mismatch");
  const file = (value: unknown, expected?: string): InputFile => {
    const f = obj(value);
    keys(f, ["path", "bytes", "sha256"]);
    const path = safeRelativePath(String(f.path)),
      bytes = integer(f.bytes, "prediction bytes", 0);
    if (
      (expected !== undefined && path !== expected) ||
      bytes > output.limits.max_file_bytes
    )
      throw new Error("Prediction file path/limit mismatch");
    return { path, bytes, sha256: hash(f.sha256) };
  };
  const predictions = file(x.predictions, output.prediction_file);
  const exported =
    x.export === null ? null : file(x.export, output.export_file);
  if (options.exported !== false && !exported)
    throw new Error("Missing benchmark export");
  const expected = file(x.expected_features);
  if (
    !task.inputs.some((f) =>
      f.path.endsWith(`/${expected.path}`) || f.path === expected.path
        ? f.sha256 === expected.sha256 && f.bytes === expected.bytes
        : false,
    )
  )
    throw new Error("Prediction features identity mismatch");
  const native = external ? null : obj(x.native_model);
  if (native) {
    keys(native, ["run_id", "frozen_id", "sha256", "bytes", "delivery_sha256"]);
    id(native.run_id);
    hash(native.frozen_id);
    hash(native.sha256);
    hash(native.delivery_sha256);
    integer(native.bytes, "native model bytes", 1);
  } else if (x.native_model !== undefined && x.native_model !== null)
    throw new Error("External method cannot claim native experiment identity");
  const producer = external ? producerSchema.parse(x.producer) : null;
  const modelBundle = external
    ? modelBundleReferenceSchema.parse(x.model_bundle)
    : null;
  const datasetHash = hash(x.dataset_sha256);
  if (datasetHash !== task.version) {
    const receipt = obj(x.execution_preparation);
    if (
      receipt.version !== 1 ||
      receipt.algorithm !== "dataset-seed-v1" ||
      receipt.source_sha256 !== task.version ||
      receipt.dataset_sha256 !== datasetHash ||
      receipt.seed !== seed
    )
      throw new Error("Prediction seed preparation mismatch");
  } else if (x.execution_preparation !== null)
    throw new Error("Unexpected seed preparation");
  const workflow = obj(x.workflow);
  keys(workflow, [
    "search_end",
    "delivery_status",
    "prediction_status",
    "reproduction_status",
    ...(external
      ? []
      : ["search_best_experiment_id", "selected_experiment_id"]),
    "confirmation",
    "usage",
    "wall_ms",
  ]);
  if (
    workflow.delivery_status !== "completed" ||
    workflow.prediction_status !== "completed" ||
    workflow.reproduction_status !== "not_run"
  )
    throw new Error("Incomplete prediction workflow");
  obj(workflow.search_end);
  obj(workflow.usage);
  if (external) {
    if (workflow.confirmation !== "not_applicable")
      throw new Error("External confirmation must be not_applicable");
    validateUsage(workflow.usage);
    const end = obj(workflow.search_end);
    keys(end, ["status", "reason"]);
    if (
      !["completed", "budget_exhausted", "timed_out"].includes(
        String(end.status),
      ) ||
      typeof end.reason !== "string"
    )
      throw new Error("Invalid external search end");
  } else {
    id(workflow.search_best_experiment_id);
    id(workflow.selected_experiment_id);
  }
  if (
    typeof workflow.wall_ms !== "number" ||
    !Number.isFinite(workflow.wall_ms) ||
    workflow.wall_ms < 0
  )
    throw new Error("Invalid native wall time");
  await verifyFiles(root, [predictions, ...(exported ? [exported] : [])]);
  return {
    ...x,
    seed,
    dataset_sha256: datasetHash,
    predictions,
    export: exported,
    workflow,
    native_model: native,
    execution_preparation: x.execution_preparation,
    ...(external ? { producer, model_bundle: modelBundle } : {}),
  };
}
