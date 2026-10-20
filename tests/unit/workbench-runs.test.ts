import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeJson } from "../../src/records/store";
import {
  displayStatus,
  listRuns,
  type RunSource,
  readRun,
} from "../../src/workbench/runs";
import type { SupervisorRecord } from "../../src/workbench/supervisor";
import { workerMain } from "../../src/workbench/worker";
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

function record(
  runId: string,
  fields: Partial<SupervisorRecord> = {},
): SupervisorRecord {
  return {
    run_id: runId,
    agent_type: "eda",
    profile: "deepseek-flash",
    backend: "persistent-kernel",
    image: "statigent-runtime:dev",
    task_path: "/nonexistent/task.json",
    pid: 4242,
    started_at: "2026-10-20T00:00:00.000Z",
    ended_at: null,
    exit_code: null,
    exit_signal: null,
    summary: null,
    stderr_tail: "",
    cancel_requested_at: null,
    forced_kill: null,
    ...fields,
  };
}

const ended = (fields: Partial<SupervisorRecord> = {}) =>
  record("r", {
    ended_at: "2026-10-20T00:05:00.000Z",
    exit_code: 1,
    ...fields,
  });

test("terminal states recorded by the agent are shown as such", () => {
  for (const status of [
    "completed",
    "budget_exhausted",
    "timed_out",
    "cancelled",
    "failed",
  ] as const)
    for (const live of [true, false])
      expect(
        displayStatus({ manifestStatus: status, live, record: ended() }),
      ).toEqual({ status, detail: null, cancellable: false });
});

test("an active record is believed only while this server holds the worker", () => {
  expect(
    displayStatus({
      manifestStatus: "running",
      live: true,
      record: record("r"),
    }),
  ).toEqual({ status: "running", detail: null, cancellable: true });
  expect(
    displayStatus({ manifestStatus: "finalizing", live: true, record: null }),
  ).toMatchObject({ status: "finalizing", cancellable: true });
  // Live but the agent has not written a manifest yet.
  expect(
    displayStatus({ manifestStatus: null, live: true, record: record("r") }),
  ).toMatchObject({ status: "starting", cancellable: true });
  expect(
    displayStatus({
      manifestStatus: "running",
      live: true,
      record: record("r", { cancel_requested_at: "2026-10-20T00:01:00Z" }),
    }),
  ).toEqual({
    status: "running",
    detail: "Cancellation requested",
    cancellable: false,
  });
});

test("a worker that died without a run record is a failed start", () => {
  const view = displayStatus({
    manifestStatus: null,
    live: false,
    record: ended({ stderr_tail: "trace\nUnknown model profile: x\n" }),
  });
  expect(view).toMatchObject({ status: "failed", cancellable: false });
  expect(view.detail).toContain("exit code 1");
  expect(view.detail).toContain("Unknown model profile: x");
});

test("a worker that ended without a final state is interrupted", () => {
  const crashed = displayStatus({
    manifestStatus: "running",
    live: false,
    record: ended({ exit_code: null, exit_signal: "SIGSEGV" }),
  });
  expect(crashed.status).toBe("interrupted");
  expect(crashed.detail).toContain("signal SIGSEGV");
  const killed = displayStatus({
    manifestStatus: "finalizing",
    live: false,
    record: ended({ exit_signal: "SIGKILL", forced_kill: "cancel_grace" }),
  });
  expect(killed).toMatchObject({ status: "interrupted", cancellable: false });
  expect(killed.detail).toContain("did not confirm");
});

test("without a live worker or an exit record the state is unknown", () => {
  for (const input of [
    { manifestStatus: "running", record: null },
    { manifestStatus: "starting", record: record("r") },
    { manifestStatus: null, record: record("r") },
  ])
    expect(displayStatus({ ...input, live: false })).toMatchObject({
      status: "unknown",
      cancellable: false,
    });
});

async function completedRun(runsRoot: string, runId: string) {
  const directory = await mkdtemp(join(tmpdir(), "workbench-runs-task-"));
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
  await workerMain(
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
      client: new ScriptClient((body, i) =>
        i === 0
          ? reply([call("execute_python", { code: "x = 1" })])
          : reply([finish(String(lastFeedback(body).cell_id))]),
      ),
      createSession: fakeRuntime().createSession,
    },
  );
}

async function withManifest(
  runsRoot: string,
  from: string,
  to: string,
  change: Record<string, unknown>,
) {
  await cp(join(runsRoot, from), join(runsRoot, to), { recursive: true });
  const path = join(runsRoot, to, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeJson(path, { ...manifest, run_id: to, ...change });
}

test("listing combines run records and side records, newest first", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-runs-"));
  const runsRoot = join(root, "runs");
  const recordsRoot = join(root, "supervisor");
  await mkdir(recordsRoot, { recursive: true });
  await completedRun(runsRoot, "done");
  await withManifest(runsRoot, "done", "leftover", {
    status: "running",
    started_at: "2026-10-21T00:00:00.000Z",
  });
  await withManifest(runsRoot, "done", "killed", {
    status: "running",
    started_at: "2026-10-22T00:00:00.000Z",
  });
  await writeJson(
    join(recordsRoot, "killed.json"),
    record("killed", {
      ended_at: "2026-10-22T00:10:00.000Z",
      exit_signal: "SIGKILL",
      forced_kill: "watchdog",
    }),
  );
  await withManifest(runsRoot, "done", "active", {
    status: "running",
    started_at: "2026-10-23T00:00:00.000Z",
  });
  // A worker that failed before the agent created anything: only side records exist.
  const taskPath = join(recordsRoot, "nostart.task.json");
  await writeJson(taskPath, {
    goal: "Summarise sales",
    organization: "planner-executor",
  });
  await writeJson(
    join(recordsRoot, "nostart.json"),
    record("nostart", {
      task_path: taskPath,
      started_at: "2026-10-19T00:00:00.000Z",
      ended_at: "2026-10-19T00:00:01.000Z",
      exit_code: 1,
      stderr_tail: "Invalid model configuration",
    }),
  );
  // Corrupt record, and entries that are not runs at all.
  await mkdir(join(runsRoot, "broken"));
  await writeFile(join(runsRoot, "broken", "manifest.json"), "{");
  await mkdir(join(runsRoot, ".staging"), { recursive: true });

  const source: RunSource = {
    runsRoot,
    recordsRoot,
    isLive: (id) => id === "active",
    current: () => null,
  };
  const { runs, errors } = await listRuns(source);
  expect(runs.map((r) => [r.run_id, r.status])).toEqual([
    ["active", "running"],
    ["killed", "interrupted"],
    ["leftover", "unknown"],
    ["done", "completed"],
    ["nostart", "failed"],
  ]);
  expect(errors.map((e) => e.run_id)).toEqual(["broken"]);

  const done = runs.find((r) => r.run_id === "done");
  expect(done).toMatchObject({
    agent_type: "eda",
    goal: task.goal,
    organization: "single",
    backend: "persistent-kernel",
    model: profile.id,
    executions: 1,
    tokens: { attempts: 2, known: true },
    cancellable: false,
  });
  expect(runs.find((r) => r.run_id === "nostart")).toMatchObject({
    goal: "Summarise sales",
    organization: "planner-executor",
    model: "deepseek-flash",
    tokens: null,
  });
  expect(runs.find((r) => r.run_id === "active")?.cancellable).toBe(true);
});

test("single runs are looked up by safe ID only", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-runs-"));
  const source: RunSource = {
    runsRoot: join(root, "runs"),
    recordsRoot: join(root, "supervisor"),
    isLive: () => false,
    current: () => null,
  };
  expect(await readRun(source, "../etc")).toBeNull();
  expect(await readRun(source, "missing")).toBeNull();
  expect(await listRuns(source)).toEqual({ runs: [], errors: [] });
});
