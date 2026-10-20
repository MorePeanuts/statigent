import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NotRunningError,
  RunLimitError,
  readRecord,
  Supervisor,
  type SupervisorOptions,
  workerEnvironment,
} from "../../src/workbench/supervisor";

const FAKE_WORKER = resolve("tests/fixtures/workbench/fake-worker.ts");

// A failing test must not leave stand-in workers running (some wait forever for a signal).
const created: Supervisor[] = [];
afterEach(() => {
  for (const s of created.splice(0)) s.shutdown("SIGKILL");
});

async function supervisor(overrides: Partial<SupervisorOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "workbench-supervisor-"));
  const s = new Supervisor({
    root,
    cwd: process.cwd(),
    modelsPath: join(root, "models.json"),
    workerCommand: [process.execPath, "--no-env-file", FAKE_WORKER],
    maxRuns: 1,
    cancelGraceMs: 300,
    watchdogGraceMs: 60_000,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
    ...overrides,
  });
  created.push(s);
  return s;
}

function launch(mode: string, timeoutMs = 60_000) {
  return {
    agent_type: "eda",
    task: { mode },
    profile: { id: "alpha", api_key_env: "ALPHA_KEY" },
    backend: "persistent-kernel",
    image: "statigent-runtime:dev",
    task_timeout_ms: timeoutMs,
  };
}

async function ready(s: Supervisor, runId: string) {
  for (let i = 0; i < 200; i++) {
    if (s.current(runId)?.stderr_tail.includes("ready")) return;
    await Bun.sleep(10);
  }
  throw new Error("fake worker never became ready");
}

test("a completed worker leaves its summary in the side record", async () => {
  const s = await supervisor();
  const started = await s.start(launch("complete"));
  expect(started.pid).toBeNumber();
  expect(s.isLive(started.run_id)).toBe(true);
  const ended = await s.waitForExit(started.run_id);
  expect(ended).toMatchObject({
    exit_code: 0,
    forced_kill: null,
    summary: {
      run_id: started.run_id,
      status: "completed",
      reason: "analysis_accepted",
    },
  });
  expect(s.isLive(started.run_id)).toBe(false);
  // The persisted record matches what the waiter saw, and the task snapshot is kept beside it.
  expect(await readRecord(s.recordsRoot, started.run_id)).toEqual(ended);
  expect(JSON.parse(await readFile(started.task_path, "utf8"))).toEqual({
    mode: "complete",
  });
});

test("cancel sends SIGTERM and the agent's own cancelled outcome is kept", async () => {
  const s = await supervisor();
  const { run_id } = await s.start(launch("await-signal"));
  await ready(s, run_id);
  const requested = await s.cancel(run_id);
  expect(requested.cancel_requested_at).toBeString();
  const ended = await s.waitForExit(run_id);
  expect(ended).toMatchObject({
    exit_code: 2,
    forced_kill: null,
    summary: { status: "cancelled" },
  });
  expect(ended?.stderr_tail).toContain("ready");
});

test("a worker ignoring SIGTERM is killed after the grace period", async () => {
  const s = await supervisor();
  const { run_id } = await s.start(launch("ignore-sigterm"));
  await ready(s, run_id);
  await s.cancel(run_id);
  const ended = await s.waitForExit(run_id);
  expect(ended).toMatchObject({
    exit_signal: "SIGKILL",
    forced_kill: "cancel_grace",
    summary: null,
  });
  expect(ended?.stderr_tail).toContain("ignoring SIGTERM");
});

test("the watchdog ends a worker that outlives its task budget", async () => {
  // The watchdog fires at budget + grace (2 s). The stand-in must have installed its SIGTERM
  // handler by then, or the default signal ends it and the escalation path is never exercised;
  // under a loaded test run Bun can take well over 100 ms to start.
  const s = await supervisor({ watchdogGraceMs: 1_950 });
  const { run_id } = await s.start(launch("ignore-sigterm", 50));
  await ready(s, run_id);
  expect(s.isLive(run_id)).toBe(true);
  const ended = await s.waitForExit(run_id);
  expect(ended).toMatchObject({
    exit_signal: "SIGKILL",
    forced_kill: "watchdog",
  });
});

test("a crash is recorded with its exit code and stderr, without a summary", async () => {
  const s = await supervisor();
  const { run_id } = await s.start(launch("crash"));
  const ended = await s.waitForExit(run_id);
  expect(ended).toMatchObject({ exit_code: 1, summary: null });
  expect(ended?.stderr_tail).toContain("worker exploded");
});

test("a missing worker executable ends as a failed start", async () => {
  const s = await supervisor({ workerCommand: ["statigent-no-such-bun"] });
  const { run_id } = await s.start(launch("complete"));
  const ended = await s.waitForExit(run_id);
  expect(ended?.exit_code).toBe(-1);
  expect(ended?.stderr_tail).not.toBe("");
});

test("the concurrency limit refuses new runs while one is active", async () => {
  const s = await supervisor();
  const first = await s.start(launch("await-signal"));
  await ready(s, first.run_id);
  const refused = await s.start(launch("complete")).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(RunLimitError);
  expect((refused as RunLimitError).active).toEqual([first.run_id]);
  await s.cancel(first.run_id);
  await s.waitForExit(first.run_id);
  const next = await s.start(launch("complete"));
  expect((await s.waitForExit(next.run_id))?.exit_code).toBe(0);
});

test("cancelling a run this server does not own is refused", async () => {
  const s = await supervisor();
  expect(s.cancel("not-a-live-run")).rejects.toBeInstanceOf(NotRunningError);
});

test("server shutdown forwards SIGTERM to live workers", async () => {
  const s = await supervisor();
  const { run_id } = await s.start(launch("await-signal"));
  await ready(s, run_id);
  s.shutdown();
  expect(await s.waitForExit(run_id)).toMatchObject({
    exit_code: 2,
    summary: { status: "cancelled" },
  });
});

test("workers only receive allow-listed variables and the selected key", async () => {
  const s = await supervisor({
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALPHA_KEY: "sk-alpha",
      BETA_KEY: "sk-beta",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    },
  });
  const { run_id } = await s.start(launch("environment"));
  const visible: string[] = JSON.parse(
    (await s.waitForExit(run_id))?.summary?.reason ?? "[]",
  );
  expect(visible).toContain("ALPHA_KEY");
  expect(visible).not.toContain("BETA_KEY");
  expect(visible).not.toContain("AWS_SECRET_ACCESS_KEY");
  expect(
    workerEnvironment(
      { PATH: "/bin", ALPHA_KEY: "k", OTHER: "x" },
      "ALPHA_KEY",
    ),
  ).toEqual({ PATH: "/bin", ALPHA_KEY: "k" });
});
