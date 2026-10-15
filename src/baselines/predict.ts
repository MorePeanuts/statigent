import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { describeFile, regular } from "../evaluation/files";
import { command } from "../evaluation/process";
import type { DataLimits } from "../modeling/data-limits";
import { validatePredictionFilesV2 } from "../modeling/predictions-v2";
import type { ProtocolV2 } from "../modeling/protocol-v2";
import { sha256 } from "../records/store";
import { type FrozenBundle, verifyBundle } from "./bundle";
import { repositoryRoot } from "./source";

const resultSchema = z.strictObject({
  version: z.literal(1),
  data_base64: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  audit: z.strictObject({
    common_fit_calls: z.literal(0),
    subprocesses: z.literal(0),
    scope: z.literal("observable-python-calls-v1"),
  }),
});
export async function predictBundle(options: {
  bundleRoot: string;
  bundle: FrozenBundle;
  featuresRoot: string;
  features: { path: string; bytes: number; sha256: string };
  protocol: ProtocolV2;
  limits: DataLimits;
  seed: number;
  directory: string;
  timeout_ms: number;
  cpus: number;
  memory_bytes: number;
  signal: AbortSignal;
}) {
  const start = performance.now();
  const bundle = await verifyBundle(options.bundleRoot, options.bundle);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: false, mode: 0o755 });
  const input = join(directory, "input");
  await mkdir(input, { mode: 0o755 });
  const actual = await describeFile(
    options.featuresRoot,
    options.features.path,
  );
  if (
    actual.sha256 !== options.features.sha256 ||
    actual.bytes !== options.features.bytes
  )
    throw new Error("Prediction feature identity mismatch");
  await copyFile(
    await regular(options.featuresRoot, options.features.path),
    join(input, "features.csv"),
  );
  await chmod(join(input, "features.csv"), 0o444);
  await writeFile(
    join(input, "schema.json"),
    JSON.stringify({
      version: 1,
      protocol: options.protocol,
      seed: options.seed,
    }),
    { flag: "wx", mode: 0o444 },
  );
  const name = `statigent-baseline-predict-${randomUUID()}`;
  const remaining = () => {
    options.signal.throwIfAborted();
    const ms = options.timeout_ms - (performance.now() - start);
    if (ms <= 0) throw new Error("Prediction deadline");
    return Math.floor(ms);
  };
  let cleanup: string | null = null;
  try {
    const response = await command(
      [
        "docker",
        "run",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--cpus",
        String(options.cpus),
        "--memory",
        String(options.memory_bytes),
        "--memory-swap",
        String(options.memory_bytes),
        "--platform",
        bundle.platform,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=268435456,uid=10001,gid=10001",
        "--tmpfs",
        `/output:rw,noexec,nosuid,size=${options.limits.max_file_bytes + 1048576},uid=10001,gid=10001`,
        "--mount",
        `type=bind,src=${resolve(options.bundleRoot)},dst=/bundle,readonly`,
        "--mount",
        `type=bind,src=${input},dst=/input,readonly`,
        "--mount",
        `type=bind,src=${join(repositoryRoot, "python/statigent_baselines/predict_entry.py")},dst=/predict_entry.py,readonly`,
        "--workdir",
        "/bundle",
        "--entrypoint",
        "uv",
        bundle.image,
        "run",
        "--frozen",
        "--offline",
        "--project",
        "/opt/runtime",
        "python",
        "/predict_entry.py",
        "--entrypoint",
        bundle.entrypoint,
        "--max-bytes",
        String(options.limits.max_file_bytes),
      ],
      {
        timeout_ms: remaining(),
        signal: options.signal,
        stdout_limit:
          Math.ceil((options.limits.max_file_bytes * 4) / 3) + 1048576,
        stderr_limit: 1048576,
      },
    );
    await writeFile(join(directory, "stderr.txt"), response.stderr, {
      flag: "wx",
    });
    const result = resultSchema.parse(JSON.parse(response.stdout));
    const content = Buffer.from(result.data_base64, "base64");
    if (
      content.toString("base64") !== result.data_base64 ||
      content.length !== result.bytes ||
      sha256(content) !== result.sha256 ||
      content.length > options.limits.max_file_bytes
    )
      throw new Error("Prediction transport identity mismatch");
    const path = join(directory, "predictions.csv");
    await writeFile(path, content, { flag: "wx" });
    const validation = await validatePredictionFilesV2({
      root: directory,
      protocol: options.protocol,
      expected: { ...options.features, path: join(input, "features.csv") },
      predictions: { path, bytes: result.bytes, sha256: result.sha256 },
      limits: options.limits,
      signal: options.signal,
      timeout_ms: remaining(),
    });
    await verifyBundle(options.bundleRoot, bundle);
    const record = {
      schema_version: 1,
      prediction_id: name,
      bundle_id: bundle.bundle_id,
      entrypoint_runner_sha256: sha256(
        await Bun.file(
          join(repositoryRoot, "python/statigent_baselines/predict_entry.py"),
        )
          .arrayBuffer()
          .then((x) => Buffer.from(x)),
      ),
      validation,
      audit: result.audit,
      wall_ms: performance.now() - start,
      calls: { models: 0, fits: 0 },
    };
    await writeFile(
      join(directory, "prediction.json"),
      JSON.stringify(record),
      { flag: "wx" },
    );
    return { path, sha256: result.sha256, bytes: result.bytes, record };
  } finally {
    try {
      await command(["docker", "rm", "-f", name], { timeout_ms: 15000 });
    } catch (error) {
      cleanup = String(error);
    }
    await writeFile(
      join(directory, "cleanup.json"),
      JSON.stringify({ cleanup_error: cleanup }),
      { flag: "wx" },
    );
    await requireCleanup(cleanup);
  }
}
async function requireCleanup(error: string | null) {
  if (error)
    throw new PredictionCleanupError(
      `Prediction cleanup unconfirmed: ${error}`,
    );
}
export class PredictionCleanupError extends Error {}
