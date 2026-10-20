import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type RunOptions, runAgent } from "../agent/run";
import { parseStrictOptions } from "../cli-options";
import { selectProfile } from "../models/config";
import { RUN_ID_PATTERN, WORKER_EXIT, type WorkerSummary } from "./protocol";

// One workbench run = one process of this entry. It exists instead of reusing `bun run agent`
// because the workbench must know the run ID (and therefore the record directory) before the
// agent starts; the research CLI keeps generating its own IDs and stays unchanged.

export interface WorkerArguments {
  task: string;
  models: string;
  model: string;
  runs: string;
  runId: string;
}

const USAGE =
  "Usage: bun src/workbench/worker.ts --task FILE --models FILE --model ID --runs DIRECTORY --run-id ID";

export function parseWorkerArguments(args: string[]): WorkerArguments {
  const flags = parseStrictOptions(
    args,
    ["--task", "--models", "--model", "--runs", "--run-id"],
    USAGE,
  );
  const [task, models, model, runs, runId] = [
    flags["--task"],
    flags["--models"],
    flags["--model"],
    flags["--runs"],
    flags["--run-id"],
  ];
  if (!task || !models || !model || !runs || !runId) throw new Error(USAGE);
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid run ID");
  return { task, models, model, runs, runId };
}

/** Test seams only; a real worker always uses the agent's own model client and execution session. */
export type WorkerOverrides = Pick<RunOptions, "client" | "createSession">;

export async function workerMain(
  args: string[],
  signal: AbortSignal,
  overrides: WorkerOverrides = {},
): Promise<WorkerSummary> {
  const parsed = parseWorkerArguments(args);
  const task: unknown = JSON.parse(
    await readFile(resolve(parsed.task), "utf8"),
  );
  const models: unknown = JSON.parse(
    await readFile(resolve(parsed.models), "utf8"),
  );
  const result = await runAgent({
    ...overrides,
    runId: parsed.runId,
    task,
    profile: selectProfile(models, parsed.model),
    runRoot: resolve(parsed.runs),
    signal,
  });
  return {
    run_id: result.run_id,
    status: result.status,
    reason: result.reason,
    record_error: result.record_error,
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  // Same cancellation path as the agent CLI: the agent ends as `cancelled` and keeps its records.
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  workerMain(Bun.argv.slice(2), controller.signal)
    .then((summary) => {
      console.log(JSON.stringify(summary));
      process.exitCode =
        summary.status === "completed"
          ? WORKER_EXIT.completed
          : WORKER_EXIT.not_completed;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Worker failed");
      process.exitCode = WORKER_EXIT.error;
    });
}
