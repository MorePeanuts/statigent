import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { validateProtocolV2 } from "../modeling/protocol-v2";
import { integer, keys, obj } from "../models/validation";
import { safeRelativePath } from "../records/store";
import { hash, type InputFile, id, type PublicTask } from "./contracts";
import { regular, verifyFiles } from "./files";

/** 小型公开清单只引用原生模型身份；验证不访问模型目录或评测答案。 */
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
  ]);
  if (
    x.schema_version !== 1 ||
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
  const native = obj(x.native_model);
  keys(native, ["run_id", "frozen_id", "sha256", "bytes", "delivery_sha256"]);
  id(native.run_id);
  hash(native.frozen_id);
  hash(native.sha256);
  hash(native.delivery_sha256);
  // 模型大小不受预测交付限额控制，模型字节从不加入交付集合。
  integer(native.bytes, "native model bytes", 1);
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
    "search_best_experiment_id",
    "selected_experiment_id",
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
  id(workflow.search_best_experiment_id);
  id(workflow.selected_experiment_id);
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
  };
}
