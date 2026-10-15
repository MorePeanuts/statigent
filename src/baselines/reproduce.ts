import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import * as z from "zod";
import { uniqueOptionValue } from "../cli-options";
import { validateTask } from "../evaluation/contracts";
import { describeFile, regular, verifyFiles } from "../evaluation/files";
import {
  modelBundleReferenceSchema,
  producerSchema,
} from "../evaluation/predictions";
import {
  comparePredictionFilesV2,
  PREDICTION_TOLERANCE,
} from "../modeling/comparison-v2";
import { readBundle } from "./bundle";
import { predictBundle } from "./predict";
import { relativePathSchema } from "./protocol";

const file = z.strictObject({
  path: relativePathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const inputSchema = z.strictObject({
  schema_version: z.literal(1),
  producer: producerSchema,
  task: z.unknown().transform(validateTask),
  seed: z.number().int().nonnegative(),
  bundle_directory: z.literal("bundle"),
  model_bundle: modelBundleReferenceSchema,
  features_directory: z.literal("prediction-input"),
  features: file,
  predictions: file,
  resources: z.strictObject({
    cpus: z.number().positive().max(256),
    memory_bytes: z.number().int().positive(),
  }),
});
export async function reproduceBaseline(
  source: string,
  output: string,
  timeout_ms: number,
  signal: AbortSignal,
) {
  z.number().int().positive().parse(timeout_ms);
  const started = performance.now(),
    root = resolve(source),
    directory = resolve(output);
  const path = await regular(root, "reproduction-input.json");
  if ((await stat(path)).size > 16 * 1024 ** 2)
    throw new Error("Reproduction input limit");
  const input = inputSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (input.task.output.kind !== "predictions")
    throw new Error("Prediction task required");
  const original = await describeFile(root, "reproduction-input.json");
  await mkdir(directory, { recursive: false });
  const record = {
    schema_version: 1,
    reproduction_id: randomUUID(),
    producer: input.producer,
    source: root,
    input: original,
    tolerance: PREDICTION_TOLERANCE,
    status: "failed",
    reason: "not_completed",
    calls: { models: 0, fits: 0 },
    wall_ms: 0,
  };
  const remaining = () => {
    signal.throwIfAborted();
    const n = Math.floor(timeout_ms - (performance.now() - started));
    if (n <= 0) throw new Error("Reproduction deadline");
    return n;
  };
  try {
    await verifyFiles(root, [original, input.predictions]);
    const bundle = await readBundle(join(root, input.bundle_directory));
    const bundleFile = await describeFile(
      join(root, input.bundle_directory),
      "bundle.json",
    );
    if (
      bundle.manifest.bundle_id !== input.model_bundle.bundle_id ||
      bundleFile.sha256 !== input.model_bundle.manifest_sha256
    )
      throw new Error("Original bundle identity mismatch");
    const featuresRoot = join(root, input.features_directory);
    await verifyFiles(featuresRoot, [input.features]);
    const prediction = await predictBundle({
      bundleRoot: bundle.root,
      bundle: bundle.manifest,
      featuresRoot,
      features: input.features,
      protocol: input.task.output.protocol,
      limits: input.task.output.limits,
      seed: input.seed,
      directory: join(directory, "prediction"),
      timeout_ms: remaining(),
      ...input.resources,
      signal,
    });
    const comparison = await comparePredictionFilesV2({
      root: directory,
      protocol: input.task.output.protocol,
      expected: {
        ...input.features,
        path: await regular(featuresRoot, input.features.path),
      },
      reference: {
        ...input.predictions,
        path: await regular(root, input.predictions.path),
      },
      actual: {
        path: prediction.path,
        bytes: prediction.bytes,
        sha256: prediction.sha256,
      },
      limits: input.task.output.limits,
      timeout_ms: remaining(),
      signal,
    });
    await verifyFiles(root, [original, input.predictions]);
    await writeFile(
      join(directory, "comparison.json"),
      JSON.stringify(comparison),
      { flag: "wx" },
    );
    record.status = comparison.matched ? "passed" : "failed";
    record.reason = comparison.matched
      ? "within_fixed_tolerance"
      : "prediction_mismatch";
  } catch (error) {
    record.reason = String(error);
  }
  record.wall_ms = performance.now() - started;
  await writeFile(
    join(directory, "reproduction.json"),
    JSON.stringify(record),
    { flag: "wx" },
  );
  return { ...record, directory };
}
export async function reproduceCommand(args: string[], signal: AbortSignal) {
  const cli = new Command().exitOverride().helpOption(false);
  for (const name of ["run", "out", "timeout-ms"])
    cli.addOption(
      new Option(`--${name} <value>`)
        .makeOptionMandatory()
        .argParser(uniqueOptionValue),
    );
  cli.parse(args, { from: "user" });
  const options = z
    .strictObject({
      run: z.string().min(1),
      out: z.string().min(1),
      timeoutMs: z.coerce.number().int().positive(),
    })
    .parse(cli.opts());
  return reproduceBaseline(options.run, options.out, options.timeoutMs, signal);
}
