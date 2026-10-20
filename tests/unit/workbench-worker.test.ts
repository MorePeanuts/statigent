import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readManifest } from "../../src/records/store";
import { WORKER_EXIT } from "../../src/workbench/protocol";
import { parseWorkerArguments, workerMain } from "../../src/workbench/worker";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "workbench-worker-"));
  const taskPath = join(directory, "task.json");
  const modelsPath = join(directory, "models.json");
  await writeFile(
    taskPath,
    JSON.stringify({
      ...task,
      execution: { ...task.execution, input_root: resolve("tests/fixtures") },
    }),
  );
  await writeFile(modelsPath, JSON.stringify([profile]));
  return { directory, taskPath, modelsPath, runs: join(directory, "runs") };
}

function args(
  paths: Awaited<ReturnType<typeof files>>,
  runId = "wb-run-1",
): string[] {
  return [
    "--task",
    paths.taskPath,
    "--models",
    paths.modelsPath,
    "--model",
    profile.id,
    "--runs",
    paths.runs,
    "--run-id",
    runId,
  ];
}

test("the worker runs the agent under the pre-assigned run ID", async () => {
  const paths = await files();
  const client = new ScriptClient((body, i) =>
    i === 0
      ? reply([call("execute_python", { code: "x = 1" })])
      : reply([finish(String(lastFeedback(body).cell_id))]),
  );
  const runtime = fakeRuntime();
  const summary = await workerMain(
    args(paths, "wb-run-1"),
    new AbortController().signal,
    { client, createSession: runtime.createSession },
  );
  expect(summary).toEqual({
    run_id: "wb-run-1",
    status: "completed",
    reason: "analysis_accepted",
    record_error: false,
  });
  const manifest = await readManifest(join(paths.runs, "wb-run-1"));
  expect(manifest.run_id).toBe("wb-run-1");
  expect(manifest.status).toBe("completed");
});

test("an aborted worker ends the agent as cancelled", async () => {
  const paths = await files();
  const controller = new AbortController();
  // The signal is what SIGTERM triggers in a real worker; a reply arriving after it is discarded.
  const client = new ScriptClient(async () => {
    controller.abort();
    await Bun.sleep(5);
    return reply([call("execute_python", { code: "late" })]);
  });
  const summary = await workerMain(args(paths, "wb-run-2"), controller.signal, {
    client,
    createSession: fakeRuntime().createSession,
  });
  expect(summary.status).toBe("cancelled");
  expect((await readManifest(join(paths.runs, "wb-run-2"))).status).toBe(
    "cancelled",
  );
});

test("a reused run ID is refused instead of overwriting records", async () => {
  const paths = await files();
  const overrides = {
    client: new ScriptClient((body, i) =>
      i === 0
        ? reply([call("execute_python", { code: "x = 1" })])
        : reply([finish(String(lastFeedback(body).cell_id))]),
    ),
    createSession: fakeRuntime().createSession,
  };
  await workerMain(
    args(paths, "wb-dup"),
    new AbortController().signal,
    overrides,
  );
  await expect(
    workerMain(args(paths, "wb-dup"), new AbortController().signal, overrides),
  ).rejects.toThrow();
});

test("arguments are explicit, unique and carry a safe run ID", async () => {
  const paths = await files();
  expect(parseWorkerArguments(args(paths)).runId).toBe("wb-run-1");
  for (const bad of [
    args(paths).slice(0, -2),
    [...args(paths), "--run-id", "again"],
    args(paths, "../escape"),
    args(paths, "a/b"),
    [...args(paths), "extra"],
  ])
    expect(() => parseWorkerArguments(bad)).toThrow();
});

test("exit codes separate completion, other agent outcomes and worker errors", () => {
  expect(WORKER_EXIT).toEqual({ completed: 0, error: 1, not_completed: 2 });
});
