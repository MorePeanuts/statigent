import { resolve } from "node:path";
import { selectProfile } from "../models/config";
import { obj } from "../models/validation";
import { validateModelingTask } from "./config";
import { datasetProtocol, prepareDataset } from "./data";
import { reproduce, scoreDelivery } from "./delivery";
import { inspectModeling } from "./records";
import { runModeling } from "./run";
export function flags(
  args: string[],
  allowed: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i],
      v = args[i + 1];
    if (
      !k ||
      !allowed.includes(k) ||
      !v ||
      v.startsWith("--") ||
      out[k] !== undefined
    )
      throw new Error("Invalid or duplicate CLI option");
    out[k] = v;
  }
  return out;
}
export async function modelingMain(args: string[]): Promise<unknown> {
  const command = args[0];
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
  if (command !== "run")
    throw new Error("Expected prepare/run/inspect/reproduce/score");
  const f = flags(args.slice(1), ["--task", "--models", "--model", "--runs"]);
  if (!f["--task"]) throw new Error("run requires --task");
  const task = validateModelingTask(
    await Bun.file(resolve(f["--task"])).json(),
  );
  if (f["--model"]) {
    task.model_profile = f["--model"];
    task.eda_profile = f["--model"];
  }
  const models: unknown = await Bun.file(
    resolve(f["--models"] ?? "configs/models.json"),
  ).json();
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runModeling({
      task,
      profile: selectProfile(models, task.model_profile),
      edaProfile: selectProfile(models, task.eda_profile),
      runRoot: resolve(f["--runs"] ?? "runs/modeling"),
      signal: controller.signal,
    });
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
        !["completed", "passed"].includes(v.status)
      )
        process.exitCode = 1;
    })
    .catch((e) => {
      console.error(String(e));
      process.exitCode = 1;
    });
