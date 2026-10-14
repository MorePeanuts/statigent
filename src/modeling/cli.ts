import { resolve } from "node:path";
import { parseStrictOptions } from "../cli-options";
import { describeFile } from "../evaluation/files";
import { selectProfile } from "../models/config";
import { obj } from "../models/validation";
import { datasetProtocol, prepareDataset } from "./data";
import { reproduce, scoreDelivery } from "./delivery";
import { developmentGoal, developmentReport } from "./development";
import { predictFrozenModel } from "./frozen-model";
import {
  DEVELOPMENT_TASKS,
  modelingPreflight,
  taskWithResource,
} from "./preflight";
import { createProtocolV2 } from "./protocol-v2";
import { inspectModeling } from "./records";
import { runModeling } from "./run";
export function flags(
  args: string[],
  allowed: string[],
  booleanFlags: string[] = [],
): Record<string, string> {
  return parseStrictOptions(
    args,
    allowed,
    "Invalid or duplicate CLI option",
    booleanFlags,
  );
}
export async function modelingMain(args: string[]): Promise<unknown> {
  const command = args[0];
  if (command === "predict") {
    const f = flags(args.slice(1), [
      "--run",
      "--features-root",
      "--features",
      "--runs",
      "--timeout-ms",
    ]);
    if (
      !f["--run"] ||
      !f["--features-root"] ||
      !f["--features"] ||
      !f["--timeout-ms"]
    )
      throw new Error(
        "predict requires --run --features-root --features --timeout-ms",
      );
    const timeout = Number(f["--timeout-ms"]);
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new Error("Invalid prediction timeout");
    const inputRoot = resolve(f["--features-root"]),
      file = await describeFile(inputRoot, f["--features"]);
    const controller = new AbortController(),
      stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      return await predictFrozenModel({
        frozenRoot: resolve(f["--run"]),
        runRoot: resolve(f["--runs"] ?? "runs/modeling-predictions"),
        features: { ...file, path: resolve(inputRoot, file.path) },
        timeout_ms: timeout,
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  if (command === "protocol") {
    const f = flags(args.slice(1), ["--config"]);
    if (!f["--config"]) throw new Error("protocol requires --config");
    return {
      status: "passed",
      scope: "protocol-only",
      protocol: createProtocolV2(await Bun.file(resolve(f["--config"])).json()),
      execution: "not_checked",
      llm_calls: 0,
    };
  }
  if (command === "prepare") {
    const f = flags(args.slice(1), ["--config", "--out"]);
    if (!f["--config"] || !f["--out"])
      throw new Error("prepare requires --config and --out");
    const dataset = await prepareDataset(
      await Bun.file(resolve(f["--config"])).json(),
      resolve(f["--out"]),
    );
    return {
      directory: resolve(f["--out"]),
      metric: dataset.metric,
      protocol: datasetProtocol(dataset),
      training_rows: dataset.split.train.length,
      validation_rows: dataset.split.validation.length,
      split_sha256: dataset.split.sha256,
    };
  }
  if (command === "inspect") {
    const f = flags(args.slice(1), ["--run"]);
    if (!f["--run"]) throw new Error("inspect requires --run");
    return inspectModeling(resolve(f["--run"]));
  }
  if (command === "reproduce") {
    const f = flags(args.slice(1), ["--run", "--runs", "--mode"]);
    if (
      !f["--run"] ||
      (f["--mode"] !== undefined && !["predict", "refit"].includes(f["--mode"]))
    )
      throw new Error(
        "reproduce requires --run and optional --mode predict/refit",
      );
    return reproduce(
      resolve(f["--run"]),
      resolve(f["--runs"] ?? "runs/modeling-reproductions"),
      f["--mode"] === "refit" ? "refit" : "predict",
    );
  }
  if (command === "score") {
    const f = flags(args.slice(1), [
      "--run",
      "--labels-root",
      "--labels",
      "--runs",
    ]);
    if (!f["--run"] || !f["--labels-root"] || !f["--labels"])
      throw new Error("score requires --run --labels-root --labels");
    return scoreDelivery(
      resolve(f["--run"]),
      resolve(f["--labels-root"]),
      f["--labels"],
      resolve(f["--runs"] ?? "runs/modeling-scores"),
    );
  }
  if (command !== "run" && command !== "develop" && command !== "fit")
    throw new Error(
      "Expected protocol/prepare/run/fit/predict/inspect/reproduce/score",
    );
  const f = flags(
    args.slice(1),
    [
      "--task",
      "--models",
      "--model",
      "--runs",
      "--method",
      "--resource",
      "--seed",
    ],
    ["--preflight"],
  );
  const preflight = f["--preflight"] === "true";
  if (!f["--task"]) throw new Error("run requires --task");
  let taskPath = f["--task"];
  if (command === "develop") {
    if (
      !f["--method"] ||
      !f["--resource"] ||
      !f["--seed"] ||
      !Object.hasOwn(DEVELOPMENT_TASKS, taskPath)
    )
      throw new Error(
        "develop requires one explicit --task s3e9|binary|multiclass, --method, --seed and --resource file",
      );
    taskPath = DEVELOPMENT_TASKS[taskPath as keyof typeof DEVELOPMENT_TASKS];
  }
  const raw = obj(await Bun.file(resolve(taskPath)).json());
  if (command === "fit") {
    if (raw.schema_version !== 4)
      throw new Error("fit requires a modeling task v4");
    raw.delivery_mode = "fit_only";
  }
  if (f["--method"]) raw.method = f["--method"];
  const task = await taskWithResource(raw, f["--resource"]);
  if (f["--model"]) {
    task.model_profile = f["--model"];
    task.eda_profile = f["--model"];
  }
  const seed = f["--seed"] === undefined ? undefined : Number(f["--seed"]);
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0))
    throw new Error("Invalid seed");
  if (command === "develop")
    task.goal = developmentGoal(task.goal, task.method);
  const preview = await modelingPreflight(task, seed);
  const models: unknown = await Bun.file(
    resolve(f["--models"] ?? "configs/models.json"),
  ).json();
  const selectedProfile = selectProfile(models, task.model_profile),
    selectedEdaProfile = selectProfile(models, task.eda_profile);
  if (preflight)
    return {
      ...preview,
      scope: command === "develop" ? f["--task"] : taskPath,
    };
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const result = await runModeling({
      task,
      profile: selectedProfile,
      edaProfile: selectedEdaProfile,
      runRoot: resolve(f["--runs"] ?? "runs/modeling"),
      signal: controller.signal,
    });
    return command === "develop" ? developmentReport(result, preview) : result;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (import.meta.main)
  modelingMain(Bun.argv.slice(2))
    .then((x) => {
      console.log(JSON.stringify(x, null, 2));
      const v = obj(x);
      if (
        typeof v.status === "string" &&
        !["completed", "model_frozen", "passed", "ready"].includes(v.status)
      )
        process.exitCode = 1;
    })
    .catch((e) => {
      console.error(String(e));
      process.exitCode = 1;
    });
