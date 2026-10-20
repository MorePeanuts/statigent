import * as z from "zod";

// What the supervisor and the worker process agree on. Kept apart from worker.ts so the web
// server can depend on it without loading the agent itself.

export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Exit codes the supervisor relies on to tell agent outcomes from worker failures. */
export const WORKER_EXIT = {
  completed: 0,
  /** The worker crashed or could not start the agent; no summary line was written. */
  error: 1,
  /** The agent reached a non-completed terminal state and reported it. */
  not_completed: 2,
} as const;

export const AGENT_TERMINAL_STATUSES = [
  "completed",
  "budget_exhausted",
  "timed_out",
  "cancelled",
  "failed",
] as const;

/** The single JSON line a worker prints on stdout when the agent reports its own outcome. */
export const workerSummarySchema = z.object({
  run_id: z.string(),
  status: z.enum(AGENT_TERMINAL_STATUSES),
  reason: z.string(),
  record_error: z.boolean(),
});
export type WorkerSummary = z.infer<typeof workerSummarySchema>;
