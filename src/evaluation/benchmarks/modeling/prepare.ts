import { randomUUID } from "node:crypto";
import { open, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseDataLimits } from "../../../modeling/data-limits";
import { parseDatasetV3 } from "../../../modeling/dataset-v3";
import { canonicalJson } from "../../../modeling/protocol-v2";
import { integer, keys, obj, str } from "../../../models/validation";
import { sha256 } from "../../../records/store";
import { command, commandEnvironment } from "../../process";
import { parseModelingCatalog } from "./catalog";

export const PREPARE_HELP =
  "evaluate prepare --config FILE (--out NEW_DIRECTORY | --reuse PREPARED_DIRECTORY) [--receipt NEW_FILE]";
export function parsePreparationConfig(value: unknown) {
  const raw = obj(value);
  keys(raw, [
    "schema_version",
    "benchmark",
    "task_id",
    "data_root",
    "catalog",
    "seed",
    "limits",
    "timeout_ms",
  ]);
  if (
    raw.schema_version !== 1 ||
    (raw.benchmark !== "dsbench-modeling" && raw.benchmark !== "tabarena-lite")
  )
    throw new Error("Invalid preparation version/benchmark");
  return {
    schema_version: 1 as const,
    benchmark: raw.benchmark,
    task_id: str(raw.task_id, "task ID"),
    data_root: resolve(str(raw.data_root, "data root")),
    catalog: resolve(str(raw.catalog, "catalog")),
    seed: integer(raw.seed, "seed", 0),
    limits: parseDataLimits(raw.limits),
    timeout_ms: integer(raw.timeout_ms, "preparation timeout"),
  };
}
export async function prepareModeling(
  args: string[],
  dependencies: { execute?: typeof command; signal?: AbortSignal } = {},
) {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !["--config", "--out", "--reuse", "--receipt"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options[key] !== undefined
    )
      throw new Error(PREPARE_HELP);
    options[key] = value;
  }
  if (
    !options["--config"] ||
    Boolean(options["--out"]) === Boolean(options["--reuse"]) ||
    (options["--reuse"] && !options["--receipt"])
  )
    throw new Error(PREPARE_HELP);
  const config = parsePreparationConfig(
    await Bun.file(options["--config"]).json(),
  );
  const catalogBytes = await Bun.file(config.catalog).arrayBuffer();
  const catalog = parseModelingCatalog(
    JSON.parse(Buffer.from(catalogBytes).toString("utf8")),
  );
  const task = catalog.tasks.find(
    (t) => t.benchmark === config.benchmark && t.task_id === config.task_id,
  );
  if (!task) throw new Error("Preparation task missing from catalog");
  const directory = resolve(options["--out"] ?? options["--reuse"] ?? "");
  const root = options["--reuse"]
    ? await realpath(directory)
    : resolve(
        await realpath(dirname(directory)),
        directory.split("/").at(-1) ?? "",
      );
  const receipt = resolve(options["--receipt"] ?? `${root}.preparation.json`);
  const sourceRoot = await realpath(config.data_root);
  const request = {
    version: 1,
    request_id: randomUUID(),
    operation: options["--reuse"] ? "reuse" : "prepare",
    task,
    source_root: sourceRoot,
    dataset_root: root,
    seed: config.seed,
    limits: config.limits,
  };
  const started = performance.now();
  const base = {
    schema_version: 1,
    request_id: request.request_id,
    config,
    catalog_sha256: sha256(Buffer.from(catalogBytes)),
    operation: request.operation,
    dataset_root: root,
  };
  const input = JSON.stringify(request);
  const receiptFile = await open(receipt, "wx", 0o600);
  try {
    if (Buffer.byteLength(input) > 1024 * 1024)
      throw new Error("Preparation request too large");
    const env = commandEnvironment();
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    const response = await (dependencies.execute ?? command)(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-m",
        "statigent_benchmarks.prepare",
      ],
      {
        input,
        timeout_ms: config.timeout_ms,
        signal: dependencies.signal,
        stdout_limit: 16 * 1024 * 1024,
        stderr_limit: 65536,
        env: { ...env, PYTHONPATH: resolve("python") },
      },
    );
    const raw = obj(JSON.parse(response.stdout));
    keys(raw, ["version", "request_id", "ok", "result", "error"]);
    if (
      raw.version !== 1 ||
      raw.request_id !== request.request_id ||
      typeof raw.ok !== "boolean"
    )
      throw new Error("Preparation response identity mismatch");
    if (!raw.ok) throw new Error(str(raw.error, "preparation error"));
    if (raw.error !== undefined)
      throw new Error("Conflicting preparation response");
    const result = obj(raw.result);
    keys(result, [
      "operation",
      "dataset",
      "dataset_root",
      "elapsed_ms",
      "reused_from",
      "original_preparation",
      "llm_calls",
      "fits",
      "downloads",
    ]);
    const dataset = parseDatasetV3(result.dataset);
    if (
      result.operation !== request.operation ||
      result.dataset_root !== root ||
      result.llm_calls !== 0 ||
      result.fits !== 0 ||
      result.downloads !== 0 ||
      result.reused_from !== (request.operation === "reuse" ? root : null) ||
      dataset.seed !== config.seed ||
      canonicalJson(dataset.limits) !== canonicalJson(config.limits) ||
      canonicalJson(result.original_preparation) !==
        canonicalJson(dataset.preparation) ||
      dataset.provenance.benchmark !== config.benchmark ||
      dataset.provenance.task_id !== config.task_id
    )
      throw new Error("Preparation result mismatch");
    const costPath = resolve(root, "preparation-cost.json");
    const currentCost = {
      schema_version: 1,
      dataset_sha256: dataset.dataset_sha256,
      worker_elapsed_ms: integer(result.elapsed_ms, "elapsed", 0),
      elapsed_ms: Math.round(performance.now() - started),
    };
    if (request.operation === "prepare")
      await writeFile(costPath, `${JSON.stringify(currentCost)}\n`, {
        flag: "wx",
        mode: 0o444,
      });
    if (
      (await realpath(costPath)) !== costPath ||
      Bun.file(costPath).size > 65536
    )
      throw new Error("Invalid original preparation cost file");
    const costBytes = await Bun.file(costPath).bytes();
    const originalCost = obj(
      JSON.parse(Buffer.from(costBytes).toString("utf8")),
    );
    keys(originalCost, [
      "schema_version",
      "dataset_sha256",
      "worker_elapsed_ms",
      "elapsed_ms",
    ]);
    if (
      originalCost.schema_version !== 1 ||
      originalCost.dataset_sha256 !== dataset.dataset_sha256
    )
      throw new Error("Original preparation cost identity mismatch");
    integer(originalCost.worker_elapsed_ms, "original worker elapsed", 0);
    integer(originalCost.elapsed_ms, "original elapsed", 0);
    const saved = {
      ...base,
      status: "passed",
      dataset_sha256: dataset.dataset_sha256,
      reused_from: result.reused_from,
      original_preparation: dataset.preparation,
      original_cost: {
        ...originalCost,
        path: "preparation-cost.json",
        bytes: costBytes.length,
        sha256: sha256(Buffer.from(costBytes)),
      },
      worker_elapsed_ms: integer(result.elapsed_ms, "elapsed", 0),
      elapsed_ms: Math.round(performance.now() - started),
      llm_calls: 0,
      fits: 0,
      downloads: 0,
    };
    await receiptFile.writeFile(`${JSON.stringify(saved, null, 2)}\n`);
    return {
      ...saved,
      receipt,
      rows: dataset.rows,
      protocol: dataset.protocol,
    };
  } catch (error) {
    await receiptFile.writeFile(
      `${JSON.stringify({ ...base, status: "failed", error: String(error), elapsed_ms: Math.round(performance.now() - started), llm_calls: 0, fits: 0, downloads: 0 }, null, 2)}\n`,
    );
    throw error;
  } finally {
    await receiptFile.close();
  }
}
