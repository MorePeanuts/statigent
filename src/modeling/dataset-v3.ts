import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";
import { type DataLimits, parseDataLimits } from "./data-limits";
import { canonicalJson, validateProtocolV2 } from "./protocol-v2";

function hash(value: unknown): string {
  const text = str(value, "SHA256");
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error("Invalid SHA256");
  return text;
}
function file(value: unknown, path: string, limits: DataLimits) {
  const raw = obj(value);
  keys(raw, ["path", "bytes", "sha256"]);
  const bytes = integer(raw.bytes, "file bytes", 0);
  if (raw.path !== path || bytes > limits.max_file_bytes)
    throw new Error("Invalid partition file reference/size");
  return { path, bytes, sha256: hash(raw.sha256) };
}
export function parseDatasetV3(value: unknown) {
  const raw = obj(value);
  keys(raw, [
    "schema_version",
    "protocol",
    "seed",
    "limits",
    "excluded_columns",
    "training",
    "prediction",
    "evaluator",
    "feature_schema",
    "public_context",
    "split",
    "rows",
    "provenance",
    "preparation",
    "dataset_sha256",
  ]);
  if (raw.schema_version !== 3) throw new Error("Unsupported dataset version");
  const { dataset_sha256: digest, ...content } = raw;
  if (hash(digest) !== sha256(Buffer.from(canonicalJson(content))))
    throw new Error("Dataset manifest hash mismatch");
  const limits = parseDataLimits(raw.limits),
    protocol = validateProtocolV2(raw.protocol);
  const excluded = strings(raw.excluded_columns, "excluded columns");
  if (
    new Set(excluded).size !== excluded.length ||
    excluded.some((c) => protocol.feature_columns.includes(c))
  )
    throw new Error("Invalid feature exclusions");
  const evaluator = obj(raw.evaluator),
    split = obj(raw.split),
    rows = obj(raw.rows),
    preparation = obj(raw.preparation);
  keys(evaluator, ["labels", "source_rows"]);
  keys(split, ["file", "method", "train_rows", "validation_rows"]);
  keys(rows, ["training", "prediction"]);
  keys(preparation, ["created_at", "elapsed_ms", "reused_from"]);
  const createdAt = str(preparation.created_at, "created at");
  if (
    !Number.isFinite(Date.parse(createdAt)) ||
    preparation.reused_from !== null
  )
    throw new Error("Invalid preparation provenance");
  const method = str(split.method, "split method");
  if (
    ![
      "hash-v1",
      "stratified-hash-v1",
      "multilabel-hash-v1",
      "explicit-v1",
    ].includes(method)
  )
    throw new Error("Unknown split method");
  const trainRows = integer(split.train_rows, "fit rows"),
    validationRows = integer(split.validation_rows, "validation rows");
  const training = integer(rows.training, "training rows"),
    prediction = integer(rows.prediction, "prediction rows", 0);
  if (
    training !== trainRows + validationRows ||
    training > limits.max_rows ||
    prediction > limits.max_rows ||
    (prediction === 0) !== (raw.prediction === null) ||
    (raw.prediction === null && evaluator.labels !== null)
  )
    throw new Error("Partition row count mismatch");
  if (!Array.isArray(raw.public_context))
    throw new Error("Invalid public context");
  const contextPaths = new Set<string>();
  const context = raw.public_context.map((value) => {
    const path = str(obj(value).path, "context path");
    if (
      !["search/task.txt", "search/adaptation.json"].includes(path) ||
      contextPaths.has(path)
    )
      throw new Error("Invalid public context path");
    contextPaths.add(path);
    return file(value, path, limits);
  });
  return {
    schema_version: 3 as const,
    protocol,
    limits,
    seed: integer(raw.seed, "seed", 0),
    excluded_columns: excluded,
    training: file(raw.training, "search/train.csv", limits),
    prediction:
      raw.prediction === null
        ? null
        : file(raw.prediction, "final-prediction/test.csv", limits),
    evaluator: {
      labels:
        evaluator.labels === null
          ? null
          : file(evaluator.labels, "evaluator/labels.csv", limits),
      source_rows: file(
        evaluator.source_rows,
        "evaluator/source-rows.jsonl",
        limits,
      ),
    },
    feature_schema: file(raw.feature_schema, "search/features.json", limits),
    public_context: context,
    split: {
      file: file(split.file, "search/split.json", limits),
      method,
      train_rows: trainRows,
      validation_rows: validationRows,
    },
    rows: { training, prediction },
    provenance: obj(raw.provenance),
    preparation: {
      created_at: createdAt,
      elapsed_ms: integer(preparation.elapsed_ms, "preparation elapsed", 0),
      reused_from: null,
    },
    dataset_sha256: hash(digest),
  };
}
export type DatasetV3 = ReturnType<typeof parseDatasetV3>;

export async function loadDatasetV3(
  directory: string,
  options: {
    limits?: DataLimits;
    timeout_ms?: number;
    signal?: AbortSignal;
    execute?: typeof command;
  } = {},
) {
  const root = await realpath(resolve(directory));
  const args = [
    "uv",
    "run",
    "--offline",
    "--frozen",
    "--no-sync",
    "python",
    "-m",
    "statigent_modeling.dataset_v3",
    root,
  ];
  if (options.limits)
    args.push("--limits", JSON.stringify(parseDataLimits(options.limits)));
  const result = await (options.execute ?? command)(args, {
    timeout_ms: options.timeout_ms ?? 60000,
    signal: options.signal,
    stdout_limit: 16 * 1024 * 1024,
    stderr_limit: 65536,
    env: { ...commandEnvironment(), PYTHONPATH: resolve("python") },
  });
  const dataset = parseDatasetV3(JSON.parse(result.stdout));
  // 控制层只保留描述符；不通过 JSON 跨进程复制训练表或测试表。
  return { root, dataset };
}
