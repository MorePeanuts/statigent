import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type DatasetV3,
  loadDatasetV3,
  parseDatasetV3,
} from "../../../modeling/dataset-v3";
import { safeRelativePath } from "../../../records/store";
import {
  INPUT_PHASES,
  type InputFile,
  type Invocation,
  type PublicTask,
  validateTask,
} from "../../contracts";
import { describeFile, regular, verifyFiles } from "../../files";

function layout(prefix: string, dataset: DatasetV3, manifest: InputFile) {
  if (!dataset.prediction)
    throw new Error("Benchmark task requires deferred prediction features");
  const path = (file: string) =>
    safeRelativePath(prefix ? `${prefix}/${file}` : file);
  const training = [
    manifest,
    ...[
      dataset.training,
      dataset.feature_schema,
      dataset.split.file,
      ...dataset.public_context,
    ].map((f) => ({ ...f, path: path(f.path) })),
  ];
  const predictionFeature = {
    ...dataset.prediction,
    path: path(dataset.prediction.path),
  };
  const prediction = [
    { ...dataset.feature_schema, path: path(dataset.feature_schema.path) },
    predictionFeature,
  ];
  const trainingPaths = training.map((f) => f.path);
  return {
    inputs: [...training, predictionFeature],
    phase_inputs: {
      search: trainingPaths,
      eda: trainingPaths,
      confirmation: trainingPaths,
      final_fit: trainingPaths,
      prediction: prediction.map((f) => f.path),
    },
  };
}

export async function modelingTaskFromPrepared(
  sourceRoot: string,
  prefix: string,
  id: string,
  goal: string,
): Promise<PublicTask> {
  const manifestPath = safeRelativePath(
    prefix ? `${prefix}/dataset.json` : "dataset.json",
  );
  const manifest = await describeFile(sourceRoot, manifestPath);
  const { dataset } = await loadDatasetV3(resolve(sourceRoot, prefix));
  return validateTask({
    schema_version: 3,
    id,
    version: dataset.dataset_sha256,
    goal,
    constraints: [
      "只使用阶段白名单输入；预处理和模型选择限于内部训练划分。冻结模型后才能读取外层预测特征。",
    ],
    ...layout(prefix, dataset, manifest),
    output: {
      kind: "predictions",
      instructions: "生成冻结协议要求的规范预测和原生模型身份引用。",
      protocol: dataset.protocol,
      input_manifest: manifestPath,
      prediction_file: "predictions.csv",
      export_file: "export.csv",
      manifest_file: "prediction-manifest.json",
      limits: dataset.limits,
      max_total_bytes: 2 * dataset.limits.max_file_bytes + 16 * 1024 ** 2,
    },
  });
}

/** 核对各阶段清单与准备数据身份，返回冻结后唯一允许追加的预测输入发布操作。 */
export async function nativeModelingPublication(i: Invocation) {
  if (i.task.output.kind !== "predictions" || !i.phase_roots)
    throw new Error("Phased prediction invocation required");
  const output = i.task.output,
    manifestPath = output.input_manifest;
  const file = await regular(i.phase_roots.search, manifestPath);
  if ((await stat(file)).size > 16 * 1024 ** 2)
    throw new Error("Prepared manifest limit");
  const dataset = parseDatasetV3(JSON.parse(await readFile(file, "utf8")));
  const dir = dirname(manifestPath),
    prefix = dir === "." ? "" : dir;
  const manifest = i.task.inputs.find((f) => f.path === manifestPath);
  if (!manifest) throw new Error("Missing public dataset manifest");
  const expected = layout(prefix, dataset, manifest);
  if (
    !isDeepStrictEqual(i.task.inputs, expected.inputs) ||
    !isDeepStrictEqual(i.task.phase_inputs, expected.phase_inputs) ||
    !isDeepStrictEqual(output.protocol, dataset.protocol) ||
    !isDeepStrictEqual(output.limits, dataset.limits) ||
    i.task.version !== dataset.dataset_sha256
  )
    throw new Error("Modeling phase/protocol/dataset identity mismatch");
  for (const phase of INPUT_PHASES) {
    const paths = expected.phase_inputs[phase];
    await verifyFiles(
      i.phase_roots[phase],
      i.task.inputs.filter((f) => paths.includes(f.path)),
    );
  }
  const root = resolve(i.phase_roots.search, prefix),
    predictionRoot = i.phase_roots.prediction;
  let published = false;
  return {
    root,
    dataset,
    async publishPrediction() {
      if (published || !dataset.prediction)
        throw new Error(
          "Prediction inputs may only be published once after freezing",
        );
      published = true;
      const path = prefix
        ? `${prefix}/${dataset.prediction.path}`
        : dataset.prediction.path;
      const source = await regular(predictionRoot, path),
        target = join(root, dataset.prediction.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target, constants.COPYFILE_EXCL);
      await verifyFiles(root, [dataset.prediction]);
    },
  };
}
