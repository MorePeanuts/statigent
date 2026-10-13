import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import binaryConfig from "../../configs/modeling/binary.json";
import binarySelection from "../../configs/modeling/binary-selection.json";
import multiclassConfig from "../../configs/modeling/multiclass.json";
import multiclassSelection from "../../configs/modeling/multiclass-selection.json";
import { verifyFiles } from "../evaluation/files";
import type { ModelClient } from "../models/client";
import { selectProfile } from "../models/config";
import { obj } from "../models/validation";
import { validateModelingTask } from "./config";
import { loadDataset, validateDataset } from "./data";
import { reproduce } from "./delivery";
import { runModeling } from "./run";
import { validateSmoke, writeSmokeReport } from "./smoke";
export type ClassificationKind = "binary" | "multiclass";
export function smokeArgs(args: string[]) {
  let kind: ClassificationKind | undefined;
  let preflight = false;
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === "--kind" &&
      kind === undefined &&
      ["binary", "multiclass"].includes(args[i + 1] ?? "")
    ) {
      kind = args[++i] === "binary" ? "binary" : "multiclass";
    } else if (args[i] === "--preflight" && !preflight) preflight = true;
    else
      throw new Error(
        "Expected --kind binary|multiclass and optional --preflight",
      );
  }
  if (!kind)
    throw new Error(
      "Explicit --kind binary|multiclass is required; one task per invocation",
    );
  return { kind, preflight };
}
export async function classificationPreflight(
  kind: ClassificationKind,
  datasetRoot?: string,
) {
  if (kind !== "binary" && kind !== "multiclass")
    throw new Error("Invalid classification smoke scope");
  const config = validateModelingTask(
    kind === "binary" ? binaryConfig : multiclassConfig,
  );
  const selection = kind === "binary" ? binarySelection : multiclassSelection;
  validateDataset(selection.dataset);
  await verifyFiles(resolve(selection.source_root), selection.sources);
  if (datasetRoot) config.dataset_root = resolve(datasetRoot);
  const data = await loadDataset(resolve(config.dataset_root));
  if (JSON.stringify(data.dataset) !== JSON.stringify(selection.dataset))
    throw new Error("Frozen classification dataset mismatch");
  return { config, selection };
}
export async function classificationSmoke(
  kind: ClassificationKind,
  options: {
    datasetRoot?: string;
    runRoot?: string;
    models?: unknown;
    client?: ModelClient;
    edaClient?: ModelClient;
    signal?: AbortSignal;
    run?: typeof runModeling;
  } = {},
) {
  const { config, selection } = await classificationPreflight(
    kind,
    options.datasetRoot,
  );
  const models =
    options.models ?? (await Bun.file("configs/models.json").json());
  const profile = selectProfile(models, config.model_profile),
    edaProfile = selectProfile(models, config.eda_profile);
  const root = resolve(
    options.runRoot ?? "runs/classification-smoke",
    randomUUID(),
  );
  await mkdir(root, { recursive: true });
  let result: Awaited<ReturnType<typeof runModeling>> | null = null;
  try {
    result = await (options.run ?? runModeling)({
      task: config,
      profile,
      edaProfile,
      runRoot: root,
      client: options.client,
      edaClient: options.edaClient,
      signal: options.signal,
    });
    const evidence = await validateSmoke(result.directory);
    const replay = await reproduce(
      result.directory,
      join(root, "reproductions"),
    );
    if (replay.status !== "passed")
      throw new Error(`Prediction reproduction ${replay.reason}`);
    const report = {
      status: "passed",
      kind,
      selection,
      run: result,
      evidence,
      reproduction: replay.directory,
    };
    await writeSmokeReport(root, report);
    return { directory: root, ...report };
  } catch (error) {
    const report = {
      status: "failed",
      kind,
      selection,
      run: result,
      reason: String(error),
    };
    await writeSmokeReport(root, report);
    return { directory: root, ...report };
  }
}
export async function classificationSmokeMain(args: string[]) {
  const { kind, preflight } = smokeArgs(args);
  if (preflight) {
    const { config, selection } = await classificationPreflight(kind);
    return {
      status: "passed",
      kind,
      mode: "preflight",
      dataset: selection.dataset,
      budget: config.budget,
    };
  }
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await classificationSmoke(kind, { signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (import.meta.main)
  classificationSmokeMain(Bun.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (obj(result).status !== "passed") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
