import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, commandEnvironment } from "../evaluation/process";
import { integer, keys, obj } from "../models/validation";
import { type DatasetV3, parseDatasetV3 } from "./dataset-v3";

export async function prepareExecutionSeed(options: {
  root: string;
  sourceRoot: string;
  dataset: DatasetV3;
  seed: number;
  timeout_ms: number;
  signal?: AbortSignal;
}) {
  integer(options.seed, "execution seed", 0);
  if (options.seed >= 2 ** 32)
    throw new Error("Execution seed outside runner range");
  const directory = resolve(options.root, "seed-preparations", randomUUID());
  await mkdir(directory, { recursive: true });
  const output = join(directory, "dataset"),
    requestId = randomUUID();
  const request = {
    version: 1,
    request_id: requestId,
    source_root: options.sourceRoot,
    source_sha256: options.dataset.dataset_sha256,
    output_root: output,
    seed: options.seed,
  };
  await writeFile(join(directory, "request.json"), JSON.stringify(request), {
    flag: "wx",
  });
  try {
    const response = await command(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-m",
        "statigent_modeling.execution_seed",
      ],
      {
        input: JSON.stringify(request),
        timeout_ms: options.timeout_ms,
        signal: options.signal,
        stdout_limit: 1024 ** 2,
        stderr_limit: 65536,
        env: { ...commandEnvironment(), PYTHONPATH: resolve("python") },
      },
    );
    const raw = obj(JSON.parse(response.stdout));
    keys(raw, ["version", "request_id", "ok", "result", "error"]);
    await writeFile(join(directory, "response.json"), response.stdout, {
      flag: "wx",
    });
    if (raw.version !== 1 || raw.request_id !== requestId || raw.ok !== true)
      throw new Error(`Seed preparation failed: ${String(raw.error)}`);
    if (raw.error !== undefined) throw new Error("Conflicting seed response");
    const result = obj(raw.result);
    keys(result, ["directory", "dataset_sha256", "receipt"]);
    if ((await stat(join(output, "dataset.json"))).size > 16 * 1024 ** 2)
      throw new Error("Seed manifest limit");
    const receipt = obj(result.receipt),
      calls = obj(receipt.calls);
    keys(receipt, [
      "version",
      "algorithm",
      "source_sha256",
      "dataset_sha256",
      "seed",
      "elapsed_ms",
      "calls",
      "source_preparation",
      "reused_outer_data",
    ]);
    keys(calls, ["models", "fits"]);
    const dataset = parseDatasetV3(
      JSON.parse(await readFile(join(output, "dataset.json"), "utf8")),
    );
    if (
      result.directory !== output ||
      result.dataset_sha256 !== dataset.dataset_sha256 ||
      dataset.seed !== options.seed ||
      receipt.version !== 1 ||
      receipt.algorithm !== "dataset-seed-v1" ||
      receipt.dataset_sha256 !== dataset.dataset_sha256 ||
      receipt.source_sha256 !== options.dataset.dataset_sha256 ||
      receipt.seed !== options.seed ||
      calls.models !== 0 ||
      calls.fits !== 0 ||
      receipt.reused_outer_data !== true ||
      typeof receipt.elapsed_ms !== "number" ||
      !Number.isFinite(receipt.elapsed_ms) ||
      receipt.elapsed_ms < 0 ||
      dataset.provenance.execution_seed_source !==
        options.dataset.dataset_sha256
    )
      throw new Error("Seed preparation identity mismatch");
    return { root: output, dataset, receipt: result.receipt };
  } catch (error) {
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify({ error: String(error), calls: { models: 0, fits: 0 } }),
      { flag: "wx" },
    );
    throw error;
  }
}
