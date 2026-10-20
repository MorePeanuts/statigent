import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type WorkerOverrides, workerMain } from "../../src/workbench/worker";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
  task,
} from "./agent";

/** A model that executes one cell and then finishes, citing it. */
export function finishingClient() {
  return new ScriptClient((body, i) =>
    i === 0
      ? reply([call("execute_python", { code: "x = 1\nprint(x)" })])
      : reply([finish(String(lastFeedback(body).cell_id))]),
  );
}

/**
 * Produces a real agent run record (manifest, events, artifacts, notebook) under `runsRoot`
 * with a scripted model and an in-memory session: no model API or Docker.
 */
export async function agentRun(
  runsRoot: string,
  runId: string,
  options: {
    client?: WorkerOverrides["client"];
    budget?: Record<string, number>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "workbench-agent-run-"));
  const taskPath = join(directory, "task.json");
  const modelsPath = join(directory, "models.json");
  await writeFile(
    taskPath,
    JSON.stringify({
      ...task,
      budget: { ...task.budget, ...options.budget },
      execution: { ...task.execution, input_root: resolve("tests/fixtures") },
    }),
  );
  await writeFile(modelsPath, JSON.stringify([profile]));
  return workerMain(
    [
      "--task",
      taskPath,
      "--models",
      modelsPath,
      "--model",
      profile.id,
      "--runs",
      runsRoot,
      "--run-id",
      runId,
    ],
    new AbortController().signal,
    {
      client: options.client ?? finishingClient(),
      createSession: fakeRuntime().createSession,
    },
  );
}
