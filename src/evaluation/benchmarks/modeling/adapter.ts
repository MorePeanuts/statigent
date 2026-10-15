import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadDatasetV3, parseDatasetV3 } from "../../../modeling/dataset-v3";
import { canonicalJson } from "../../../modeling/protocol-v2";
import { scoreFilesV2 } from "../../../modeling/scoring-v2";
import { keys, obj, str } from "../../../models/validation";
import { safeRelativePath, sha256 } from "../../../records/store";
import {
  type BenchmarkAdapter,
  id,
  type PublicTask,
  type Score,
} from "../../contracts";
import { regular, verifyFiles } from "../../files";
import { readPredictionManifest } from "../../predictions";
import { command, commandEnvironment } from "../../process";
import type { ModelingBenchmark } from "./catalog";
import { preparePredictionDelivery } from "./delivery";
import { modelingTaskFromPrepared } from "./publication";

export function preparedBenchmarkOptions(value: unknown) {
  const x = obj(value);
  keys(x, ["prepared_root", "datasets", "data_root"]);
  const datasets = Object.fromEntries(
    Object.entries(obj(x.datasets)).map(([task, path]) => [
      id(task),
      safeRelativePath(str(path, "prepared dataset directory")),
    ]),
  );
  if (
    !Object.keys(datasets).length ||
    Object.keys(datasets).length > 103 ||
    new Set(Object.values(datasets)).size !== Object.keys(datasets).length
  )
    throw new Error("Invalid prepared dataset selection");
  return {
    prepared_root: resolve(str(x.prepared_root, "prepared root")),
    datasets,
    data_root: resolve(str(x.data_root, "private benchmark data root")),
  };
}

export async function referenceResult(
  dataRoot: string,
  taskId: string,
  direction: string,
  value: number | null,
  signal?: AbortSignal,
) {
  const requestId = randomUUID();
  const response = await command(
    [
      "uv",
      "run",
      "--offline",
      "--frozen",
      "--no-sync",
      "python",
      "-m",
      "statigent_benchmarks.reference_bridge",
    ],
    {
      input: JSON.stringify({
        version: 1,
        request_id: requestId,
        data_root: dataRoot,
        task_id: taskId,
        direction,
        score: value,
      }),
      timeout_ms: 30000,
      signal,
      stdout_limit: 1024 ** 2,
      stderr_limit: 65536,
      env: { ...commandEnvironment(), PYTHONPATH: resolve("python") },
    },
  );
  const raw = obj(JSON.parse(response.stdout));
  keys(raw, ["version", "request_id", "ok", "result", "error"]);
  if (
    raw.version !== 1 ||
    raw.request_id !== requestId ||
    raw.ok !== true ||
    raw.error !== undefined
  )
    throw new Error(`Reference scoring failed: ${String(raw.error)}`);
  const result = obj(raw.result);
  keys(result, ["rpg", "reference_identity", "dependencies"]);
  if (
    value === null
      ? result.rpg !== null
      : typeof result.rpg !== "number" ||
        !Number.isFinite(result.rpg) ||
        result.rpg < 0
  )
    throw new Error("Invalid RPG response");
  return result;
}

/** 打开受信准备目录；既不访问原生运行也不反序列化模型。 */
async function prepared(
  options: ReturnType<typeof preparedBenchmarkOptions>,
  task: PublicTask,
  benchmark: string,
) {
  const prefix = options.datasets[task.id];
  if (!prefix) throw new Error("Unknown prepared task");
  const root = resolve(options.prepared_root, prefix),
    path = await regular(root, "dataset.json");
  if ((await stat(path)).size > 16 * 1024 ** 2)
    throw new Error("Prepared manifest limit");
  const dataset = parseDatasetV3(JSON.parse(await readFile(path, "utf8")));
  if (
    dataset.dataset_sha256 !== task.version ||
    dataset.provenance.benchmark !== benchmark ||
    dataset.provenance.task_id !== task.id ||
    task.output.kind !== "predictions" ||
    !isDeepStrictEqual(task.output.protocol, dataset.protocol)
  )
    throw new Error("Prepared evaluation identity mismatch");
  return { root, dataset };
}

export function createModelingBenchmark(
  benchmark: ModelingBenchmark,
  dependencies: { references?: typeof referenceResult } = {},
): BenchmarkAdapter {
  const protocol = `${benchmark}-predictions-v1`;
  return {
    id: benchmark,
    version: "1",
    protocol,
    options: preparedBenchmarkOptions,
    async catalog(value) {
      const options = preparedBenchmarkOptions(value);
      if ((await realpath(options.prepared_root)) !== options.prepared_root)
        throw new Error("Prepared root must be canonical");
      const tasks: PublicTask[] = [],
        identities: Record<string, unknown>[] = [];
      for (const [taskId, prefix] of Object.entries(options.datasets)) {
        const { dataset } = await loadDatasetV3(
          join(options.prepared_root, prefix),
        );
        if (
          dataset.provenance.benchmark !== benchmark ||
          dataset.provenance.task_id !== taskId
        )
          throw new Error("Prepared benchmark/task mismatch");
        const task = await modelingTaskFromPrepared(
          options.prepared_root,
          prefix,
          taskId,
          `根据训练数据预测 ${dataset.protocol.targets.map((t) => t.name).join("、")}；遵守附带题面和冻结目标协议。`,
        );
        tasks.push(task);
        identities.push({
          task_id: taskId,
          dataset_sha256: dataset.dataset_sha256,
          source_revision: dataset.provenance.source_revision,
          preparation: dataset.preparation,
          reuse: "explicit-read-only",
          openml: dataset.provenance.openml ?? null,
        });
      }
      const revisions = new Set(
        identities.map((i) => str(i.source_revision, "source revision")),
      );
      if (revisions.size !== 1) throw new Error("Mixed source revisions");
      return {
        tasks,
        source_root: options.prepared_root,
        provenance: {
          version: [...revisions][0],
          benchmark,
          prepared: identities,
        },
      };
    },
    async preflight(value, tasks) {
      const options = preparedBenchmarkOptions(value);
      for (const task of tasks) {
        const { root, dataset } = await prepared(options, task, benchmark);
        await loadDatasetV3(root);
        if (
          !dataset.prediction ||
          !dataset.evaluator.labels ||
          !dataset.evaluator.source_rows
        )
          throw new Error("Evaluation requires frozen outer members");
        if (benchmark === "dsbench-modeling")
          await (dependencies.references ?? referenceResult)(
            options.data_root,
            task.id,
            dataset.protocol.metric.direction,
            null,
          );
        else {
          const openml = obj(dataset.provenance.openml);
          if (
            openml.repeat !== 0 ||
            openml.fold !== 0 ||
            dataset.provenance.outer_split !== "openml-r0f0"
          )
            throw new Error("TabArena requires fixed r0f0");
        }
      }
    },
    async prepareDelivery(value, task, _submission, context) {
      const options = preparedBenchmarkOptions(value),
        { root } = await prepared(options, task, benchmark);
      await preparePredictionDelivery(root, task, context);
    },
    async score(value, task, submission, context) {
      const options = preparedBenchmarkOptions(value),
        { root, dataset } = await prepared(options, task, benchmark);
      const labels = dataset.evaluator.labels;
      if (!labels) throw new Error("Missing private labels");
      await verifyFiles(root, [labels]);
      // 私有资源故障即使在失败交付中也必须标为评分故障，不能伪装成零分。
      const references =
        benchmark === "dsbench-modeling"
          ? await (dependencies.references ?? referenceResult)(
              options.data_root,
              task.id,
              dataset.protocol.metric.direction,
              null,
              context.signal,
            )
          : null;
      let native: number | null = null,
        invalid: string | null = null,
        workflow: Record<string, unknown> | null = null,
        evaluationId: string | null = null;
      let components: unknown = null,
        manifestIdentity: unknown = null;
      if (submission.status === "completed") {
        const manifest = await readPredictionManifest(
          context.deliverables_root,
          task,
          { seed: context.seed },
        );
        workflow = manifest.workflow;
        manifestIdentity = {
          dataset_sha256: manifest.dataset_sha256,
          native_model: manifest.native_model,
          ...(manifest.producer
            ? {
                producer: manifest.producer,
                model_bundle: manifest.model_bundle,
              }
            : {}),
          execution_preparation: manifest.execution_preparation,
        };
        evaluationId = sha256(
          Buffer.from(
            canonicalJson({
              task_version: task.version,
              protocol_sha256: dataset.protocol.protocol_sha256,
              labels_sha256: labels.sha256,
              predictions_sha256: manifest.predictions.sha256,
              partition: "test",
            }),
          ),
        );
        const result = await scoreFilesV2({
          root: join(dirname(context.deliverables_root), "scoring-records"),
          protocol: dataset.protocol,
          evaluation_id: evaluationId,
          partition: "test",
          labels: { ...labels, path: join(root, labels.path) },
          predictions: {
            ...manifest.predictions,
            path: join(context.deliverables_root, manifest.predictions.path),
          },
          limits: dataset.limits,
          signal: context.signal,
        });
        native = result.score?.value ?? null;
        invalid = result.error;
        components = result.score?.components ?? null;
      }
      const rpg =
        benchmark === "dsbench-modeling"
          ? native === null
            ? 0
            : (
                await (dependencies.references ?? referenceResult)(
                  options.data_root,
                  task.id,
                  dataset.protocol.metric.direction,
                  native,
                  context.signal,
                )
              ).rpg
          : null;
      const metrics: Score["metrics"] = [
        {
          name: "completion",
          value: native === null ? 0 : 1,
          minimum: 0,
          maximum: 1,
          direction: "higher",
        },
      ];
      if (rpg !== null) {
        if (typeof rpg !== "number") throw new Error("Invalid RPG value");
        metrics.push({
          name: "rpg",
          value: rpg,
          minimum: 0,
          maximum: null,
          direction: "higher",
        });
      }
      return {
        schema_version: 3,
        unit_id: submission.unit_id,
        protocol,
        status: "scored",
        metrics,
        judge: null,
        error: null,
        details: {
          native: {
            metric: dataset.protocol.metric,
            value: native,
            components,
          },
          invalid_predictions: invalid,
          evaluation_id: evaluationId,
          workflow,
          delivery_identity: manifestIdentity,
          reference_identity: references?.reference_identity ?? null,
          official:
            benchmark === "tabarena-lite"
              ? {
                  error:
                    native === null
                      ? null
                      : dataset.protocol.kind === "binary"
                        ? 1 - native
                        : native,
                  direction: "lower",
                  repeat: 0,
                  fold: 0,
                  class_order: dataset.protocol.targets[0]?.classes,
                  positive_class: dataset.protocol.targets[0]?.positive_class,
                  verification: "requires-explicit-official-differential",
                }
              : null,
        },
      };
    },
  };
}
