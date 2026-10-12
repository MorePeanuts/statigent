import { resolve } from "node:path";
import { selectProfile } from "../models/config";
import { validateTask } from "./config";
import { runAgent } from "./run";
export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !flag ||
      !["--task", "--models", "--model", "--runs"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      flags[flag] !== undefined
    )
      throw new Error("Expected unique --task/--models/--model/--runs values");
    flags[flag] = value;
  }
  if (!flags["--task"]) throw new Error("Explicit --task is required");
  return flags;
}
export async function loadConfiguration(args: string[], requireModel = false) {
  const flags = parseFlags(args);
  if (requireModel && !flags["--model"])
    throw new Error("Smoke requires explicit --model");
  const task = validateTask(
    await Bun.file(resolve(flags["--task"] ?? "")).json(),
  );
  const selected = flags["--model"] ?? task.model_profile;
  const profile = selectProfile(
    await Bun.file(resolve(flags["--models"] ?? "configs/models.json")).json(),
    selected,
  );
  task.model_profile = selected;
  return { task, profile, runRoot: resolve(flags["--runs"] ?? "runs/agent") };
}
export async function agentMain(args: string[]) {
  if (args[0] !== "run")
    throw new Error(
      "Usage: bun run agent run --task TASK [--models MODELS] [--model ID] [--runs DIRECTORY]",
    );
  const configuration = await loadConfiguration(args.slice(1));
  console.log(
    JSON.stringify({
      model: configuration.profile.model,
      profile: configuration.profile.id,
      organization: configuration.task.organization,
      budget: configuration.task.budget,
      generation: configuration.profile.generation,
    }),
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runAgent({ ...configuration, signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (import.meta.main)
  agentMain(Bun.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "completed") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Agent failed");
      process.exitCode = 1;
    });
