import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { writeJson } from "../records/store";
import { RUN_ID_PATTERN, workerSummarySchema } from "./protocol";

// The supervisor owns worker processes for this server. What it knows is written next to (never
// into) the agent's run directory, so a crash before the agent creates its records, or a server
// restart, still leaves an explanation behind.

export interface RunLaunch {
  agent_type: string;
  /** The task given to the worker; the agent validates it again. */
  task: Record<string, unknown>;
  profile: { id: string; api_key_env: string };
  backend: string;
  image: string;
  /** The agent's own wall-clock budget; the watchdog only fires well after it. */
  task_timeout_ms: number;
}

export const supervisorRecordSchema = z.object({
  run_id: z.string().regex(RUN_ID_PATTERN),
  agent_type: z.string(),
  profile: z.string(),
  backend: z.string(),
  image: z.string(),
  task_path: z.string(),
  pid: z.number().int().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  exit_signal: z.string().nullable(),
  /** The worker's final stdout line, present only when the agent reported its own outcome. */
  summary: workerSummarySchema.nullable(),
  stderr_tail: z.string(),
  cancel_requested_at: z.string().nullable(),
  /** Set when the supervisor had to SIGKILL the worker; the agent never confirmed its end. */
  forced_kill: z.enum(["cancel_grace", "watchdog"]).nullable(),
});
export type SupervisorRecord = z.infer<typeof supervisorRecordSchema>;

export interface SupervisorOptions {
  /** runs/workbench: holds runs/, supervisor/ and inputs/. */
  root: string;
  /** Repository root, the worker's working directory. */
  cwd: string;
  modelsPath: string;
  /** Program and leading arguments; worker flags are appended. */
  workerCommand: string[];
  maxRuns: number;
  cancelGraceMs: number;
  watchdogGraceMs: number;
  environment: Record<string, string | undefined>;
}

export class RunLimitError extends Error {
  readonly status = 409;
  constructor(
    readonly limit: number,
    readonly active: string[],
  ) {
    super(
      `At most ${limit} concurrent run(s); wait for or cancel: ${active.join(", ")}`,
    );
  }
}

export class NotRunningError extends Error {
  readonly status = 409;
  constructor(runId: string) {
    super(`Run ${runId} is not running under this server`);
  }
}

const OUTPUT_TAIL_CHARS = 16 * 1024;
const PASSED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];

interface LiveRun {
  child: ChildProcess;
  record: SupervisorRecord;
  stdout: string;
  timers: ReturnType<typeof setTimeout>[];
  /** Record writes are chained so a fast exit can never be overwritten by an earlier snapshot. */
  writes: Promise<void>;
  exited: Promise<SupervisorRecord>;
}

/** Only what the worker needs: tool paths, Docker settings and the selected profile's key. */
export function workerEnvironment(
  source: Record<string, string | undefined>,
  keyVariable: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [...PASSED_ENVIRONMENT, keyVariable]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function workerSummary(stdout: string): SupervisorRecord["summary"] {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null; // No summary: the worker failed before reporting; exit_code records that.
  }
  const parsed = workerSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class Supervisor {
  private readonly live = new Map<string, LiveRun>();
  constructor(readonly options: SupervisorOptions) {}

  get runsRoot(): string {
    return join(this.options.root, "runs");
  }
  get recordsRoot(): string {
    return join(this.options.root, "supervisor");
  }
  recordPath(runId: string): string {
    return join(this.recordsRoot, `${runId}.json`);
  }

  activeRuns(): string[] {
    return [...this.live.keys()];
  }
  isLive(runId: string): boolean {
    return this.live.has(runId);
  }
  /** The in-memory record of a live run, including output not yet persisted. */
  current(runId: string): SupervisorRecord | null {
    const run = this.live.get(runId);
    return run ? { ...run.record } : null;
  }
  /** Resolves with the final record once the worker has exited (immediately if not live). */
  async waitForExit(runId: string): Promise<SupervisorRecord | null> {
    const run = this.live.get(runId);
    return run ? run.exited : readRecord(this.recordsRoot, runId);
  }

  async start(launch: RunLaunch): Promise<SupervisorRecord> {
    if (this.live.size >= this.options.maxRuns)
      throw new RunLimitError(this.options.maxRuns, this.activeRuns());
    const [program, ...leading] = this.options.workerCommand;
    if (!program) throw new Error("Worker command is empty");
    const runId = randomUUID();
    await mkdir(this.runsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.recordsRoot, { recursive: true, mode: 0o700 });
    const taskPath = join(this.recordsRoot, `${runId}.task.json`);
    await writeJson(taskPath, launch.task);
    // Re-check after the awaits: another submission may have taken the last slot meanwhile.
    if (this.live.size >= this.options.maxRuns)
      throw new RunLimitError(this.options.maxRuns, this.activeRuns());
    const record: SupervisorRecord = {
      run_id: runId,
      agent_type: launch.agent_type,
      profile: launch.profile.id,
      backend: launch.backend,
      image: launch.image,
      task_path: taskPath,
      pid: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      exit_signal: null,
      summary: null,
      stderr_tail: "",
      cancel_requested_at: null,
      forced_kill: null,
    };
    const child = spawn(
      program,
      [
        ...leading,
        "--task",
        taskPath,
        "--models",
        this.options.modelsPath,
        "--model",
        launch.profile.id,
        "--runs",
        this.runsRoot,
        "--run-id",
        runId,
      ],
      {
        cwd: this.options.cwd,
        env: workerEnvironment(
          this.options.environment,
          launch.profile.api_key_env,
        ),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    record.pid = child.pid ?? null;
    let resolveExit: (record: SupervisorRecord) => void = () => {};
    const run: LiveRun = {
      child,
      record,
      stdout: "",
      timers: [],
      writes: Promise.resolve(),
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
    };
    this.live.set(runId, run);
    const started = this.persist(run);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      run.stdout = (run.stdout + chunk).slice(-OUTPUT_TAIL_CHARS);
    });
    child.stderr?.on("data", (chunk: string) => {
      record.stderr_tail = (record.stderr_tail + chunk).slice(
        -OUTPUT_TAIL_CHARS,
      );
    });
    let settled = false;
    const settle = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      for (const timer of run.timers) clearTimeout(timer);
      record.ended_at = new Date().toISOString();
      record.exit_code = code;
      record.exit_signal = signal;
      record.summary = workerSummary(run.stdout);
      // Leave the live table only once the final record is on disk, so a reader that finds the
      // run no longer live never sees an older snapshot.
      void this.persist(run)
        .catch((error: unknown) =>
          console.error(`[workbench] recording exit of ${runId} failed`, error),
        )
        .finally(() => {
          this.live.delete(runId);
          resolveExit({ ...record });
        });
    };
    child.on("error", (error) => {
      // Spawn failure (e.g. missing executable) produces no exit code of its own.
      record.stderr_tail = `${record.stderr_tail}\n${error.message}`.trim();
      settle(-1, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
    run.timers.push(
      setTimeout(
        () => this.terminate(run, "watchdog"),
        launch.task_timeout_ms + this.options.watchdogGraceMs,
      ),
    );
    await started;
    return { ...record };
  }

  async cancel(runId: string): Promise<SupervisorRecord> {
    const run = this.live.get(runId);
    if (!run) throw new NotRunningError(runId);
    if (!run.record.cancel_requested_at) {
      run.record.cancel_requested_at = new Date().toISOString();
      await this.persist(run);
      this.terminate(run, "cancel_grace");
    }
    return { ...run.record };
  }

  /** Forward termination to every worker (server shutdown); synchronous so it works in exit hooks. */
  shutdown(signal: NodeJS.Signals = "SIGTERM"): void {
    for (const run of this.live.values()) run.child.kill(signal);
  }

  private terminate(run: LiveRun, reason: "cancel_grace" | "watchdog") {
    run.child.kill("SIGTERM");
    run.timers.push(
      setTimeout(() => {
        if (!this.live.has(run.record.run_id)) return;
        run.record.forced_kill = reason;
        run.child.kill("SIGKILL");
      }, this.options.cancelGraceMs),
    );
  }

  private persist(run: LiveRun): Promise<void> {
    const snapshot = { ...run.record };
    run.writes = run.writes.then(() =>
      writeJson(this.recordPath(snapshot.run_id), snapshot),
    );
    return run.writes;
  }
}

export async function readRecord(
  recordsRoot: string,
  runId: string,
): Promise<SupervisorRecord | null> {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  let text: string;
  try {
    text = await readFile(join(recordsRoot, `${runId}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return supervisorRecordSchema.parse(JSON.parse(text));
}

/**
 * Makes server shutdown reach the workers. A listener on SIGINT/SIGTERM replaces the default
 * "exit" behaviour, so when nothing else handles the signal it is re-raised after forwarding.
 */
export function installShutdownForwarding(supervisor: Supervisor): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      supervisor.shutdown("SIGTERM");
      if (process.listenerCount(signal) === 1) {
        process.off(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, handler);
  }
  process.on("exit", () => supervisor.shutdown("SIGTERM"));
}
