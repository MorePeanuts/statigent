import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { keys, obj } from "../../../models/validation";
import type { PublicTask, ScoringContext } from "../../contracts";
import { describeFile } from "../../files";
import { readPredictionManifest } from "../../predictions";
import { command, commandEnvironment } from "../../process";

export async function preparePredictionDelivery(
  preparedRoot: string,
  task: PublicTask,
  context: ScoringContext,
) {
  if (task.output.kind !== "predictions")
    throw new Error("Prediction output required");
  const root = context.deliverables_root,
    output = task.output;
  const manifest = await readPredictionManifest(root, task, {
    exported: false,
    seed: context.seed,
  });
  if (manifest.export) throw new Error("Benchmark export already exists");
  const destination = join(root, output.export_file);
  await mkdir(dirname(destination), { recursive: true });
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
      "statigent_benchmarks.delivery",
    ],
    {
      input: JSON.stringify({
        version: 1,
        request_id: requestId,
        prepared_root: preparedRoot,
        dataset_sha256: task.version,
        predictions: {
          ...manifest.predictions,
          path: join(root, manifest.predictions.path),
        },
        destination,
      }),
      timeout_ms: 60000,
      signal: context.signal,
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
    throw new Error(`Benchmark export failed: ${String(raw.error)}`);
  const result = obj(raw.result),
    calls = obj(result.calls),
    exported = obj(result.export);
  keys(result, ["dataset_sha256", "export", "calls"]);
  const file = await describeFile(root, output.export_file);
  if (
    result.dataset_sha256 !== task.version ||
    calls.models !== 0 ||
    calls.fits !== 0 ||
    exported.bytes !== file.bytes ||
    exported.sha256 !== file.sha256 ||
    file.bytes > output.limits.max_file_bytes
  )
    throw new Error("Benchmark export integrity mismatch");
  await writeFile(
    join(root, output.manifest_file),
    JSON.stringify({ ...manifest, export: file }),
  );
  await readPredictionManifest(root, task, { seed: context.seed });
}
