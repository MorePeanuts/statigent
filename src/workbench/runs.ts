import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Manifest, readManifest } from "../records/store";
import { AGENT_TERMINAL_STATUSES, RUN_ID_PATTERN } from "./protocol";
import { readRecord, type SupervisorRecord } from "./supervisor";

export type DisplayStatus =
  | "starting"
  | "running"
  | "finalizing"
  | (typeof AGENT_TERMINAL_STATUSES)[number]
  | "interrupted"
  | "unknown";

export interface StatusView {
  status: DisplayStatus;
  /** Why the status is what it is, when the agent did not say so itself. */
  detail: string | null;
  cancellable: boolean;
}

const TERMINAL = new Set<string>(AGENT_TERMINAL_STATUSES);
const ACTIVE = new Set(["starting", "running", "finalizing"]);

function stderrLine(record: SupervisorRecord): string {
  const line = record.stderr_tail.trim().split("\n").at(-1)?.slice(0, 300);
  return line ? `: ${line}` : "";
}

function exitDescription(record: SupervisorRecord): string {
  return record.exit_signal
    ? `signal ${record.exit_signal}`
    : `exit code ${record.exit_code}`;
}

/**
 * Combines what the agent recorded with whether this server still holds its worker. A record
 * that claims to be running is only believed while the worker is alive (design D4).
 */
export function displayStatus(input: {
  manifestStatus: string | null;
  live: boolean;
  record: SupervisorRecord | null;
}): StatusView {
  const { manifestStatus, live, record } = input;
  if (manifestStatus && TERMINAL.has(manifestStatus))
    return {
      status: manifestStatus as DisplayStatus,
      detail: null,
      cancellable: false,
    };
  if (live)
    return {
      status:
        manifestStatus && ACTIVE.has(manifestStatus)
          ? (manifestStatus as DisplayStatus)
          : "starting",
      detail: record?.cancel_requested_at ? "Cancellation requested" : null,
      cancellable: !record?.cancel_requested_at,
    };
  if (record?.ended_at && manifestStatus === null)
    return {
      status: "failed",
      detail: `Worker ended (${exitDescription(record)}) before the agent created its run record${stderrLine(record)}`,
      cancellable: false,
    };
  if (record?.ended_at)
    return {
      status: "interrupted",
      detail: record.forced_kill
        ? `Worker was killed after ${record.forced_kill === "watchdog" ? "exceeding its time budget" : "ignoring cancellation"}; the agent did not confirm its final state`
        : `Worker ended (${exitDescription(record)}) without a final state in the run record${stderrLine(record)}`,
      cancellable: false,
    };
  return {
    status: "unknown",
    detail:
      "No worker for this run is held by this server (for example after a restart); its final state is unknown",
    cancellable: false,
  };
}

export interface RunSummary extends StatusView {
  run_id: string;
  started_at: string | null;
  ended_at: string | null;
  agent_type: string;
  goal: string | null;
  organization: string | null;
  backend: string | null;
  model: string | null;
  tokens: { total: number; attempts: number; known: boolean } | null;
  executions: number | null;
}

export interface RunListError {
  run_id: string;
  error: string;
}

/** What the run views need from the supervisor; a plain object in tests. */
export interface RunSource {
  runsRoot: string;
  recordsRoot: string;
  isLive(runId: string): boolean;
  current(runId: string): SupervisorRecord | null;
}

async function readManifestIfPresent(
  directory: string,
): Promise<Manifest | null> {
  try {
    await lstat(join(directory, "manifest.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return readManifest(directory);
}

async function taskGoal(record: SupervisorRecord): Promise<{
  goal: string | null;
  organization: string | null;
}> {
  try {
    const task: unknown = JSON.parse(await readFile(record.task_path, "utf8"));
    if (task && typeof task === "object")
      return {
        goal:
          "goal" in task && typeof task.goal === "string" ? task.goal : null,
        organization:
          "organization" in task && typeof task.organization === "string"
            ? task.organization
            : "single",
      };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { goal: null, organization: null };
}

export async function readRun(
  source: RunSource,
  runId: string,
): Promise<RunSummary | null> {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  const record =
    source.current(runId) ?? (await readRecord(source.recordsRoot, runId));
  const manifest = await readManifestIfPresent(join(source.runsRoot, runId));
  if (!manifest && !record) return null;
  const agent =
    manifest?.agent && manifest.agent !== "not_applicable"
      ? manifest.agent
      : null;
  const tokens =
    manifest?.tokens && manifest.tokens !== "not_applicable"
      ? manifest.tokens
      : null;
  const fromTask = record
    ? await taskGoal(record)
    : { goal: null, organization: null };
  return {
    run_id: runId,
    ...displayStatus({
      manifestStatus: manifest?.status ?? null,
      live: source.isLive(runId),
      record,
    }),
    started_at: manifest?.started_at ?? record?.started_at ?? null,
    ended_at: manifest?.ended_at ?? record?.ended_at ?? null,
    agent_type: record?.agent_type ?? "eda",
    goal: agent?.goal ?? fromTask.goal,
    organization:
      manifest?.collaboration?.organization ??
      (manifest ? "single" : fromTask.organization),
    backend: manifest?.execution?.backend ?? record?.backend ?? null,
    model:
      manifest?.model && manifest.model !== "not_applicable"
        ? manifest.model.profile.id
        : (record?.profile ?? null),
    tokens: tokens
      ? {
          total: tokens.total_tokens,
          attempts: tokens.attempts,
          known: tokens.status === "known",
        }
      : null,
    executions: agent?.executions ?? null,
  };
}

async function names(directory: string, suffix = ""): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, name.length - suffix.length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Runs known to the workbench: record directories under its own run root plus side records of
 * workers that failed before creating one. Nothing outside runs/workbench is scanned.
 */
export async function listRuns(
  source: RunSource,
): Promise<{ runs: RunSummary[]; errors: RunListError[] }> {
  const ids = new Set(
    [
      ...(await names(source.runsRoot)),
      ...(await names(source.recordsRoot, ".json")),
    ].filter((id) => RUN_ID_PATTERN.test(id)),
  );
  const runs: RunSummary[] = [];
  const errors: RunListError[] = [];
  for (const id of ids) {
    try {
      const run = await readRun(source, id);
      if (run) runs.push(run);
    } catch (error) {
      errors.push({
        run_id: id,
        error: error instanceof Error ? error.message : "Unreadable run record",
      });
    }
  }
  runs.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return { runs, errors };
}
