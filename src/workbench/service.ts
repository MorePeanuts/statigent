import { mkdir, readFile } from "node:fs/promises";
import type { ExecutionBackend } from "../execution/backend";
import { buildTask, TaskError } from "./agents";
import { errorResponse } from "./http";
import {
  type CommandRunner,
  checkRunPrerequisites,
  runCommand,
} from "./preflight";
import { listRuns, readRun } from "./runs";
import { parseAfter, traceStream } from "./stream";
import { NotRunningError, RunLimitError, type Supervisor } from "./supervisor";

export interface RunServiceDependencies {
  supervisor: Supervisor;
  inputRoot: string;
  modelsPath: string;
  images: Record<ExecutionBackend, string>;
  environment: Record<string, string | undefined>;
  runCommand?: CommandRunner;
  /** Trace polling interval; tests shorten it. */
  pollMs?: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** HTTP behaviour of the run endpoints, independent of Next so it can be tested directly. */
export function createRunHandlers(deps: RunServiceDependencies) {
  const { supervisor } = deps;
  return {
    async submit(request: Request): Promise<Response> {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "Request body must be JSON" }, 400);
      }
      try {
        await mkdir(deps.inputRoot, { recursive: true, mode: 0o700 });
        const built = await buildTask(payload, {
          inputRoot: deps.inputRoot,
          models: JSON.parse(await readFile(deps.modelsPath, "utf8")),
          images: deps.images,
        });
        const problems = await checkRunPrerequisites(
          {
            profile: built.profile,
            backend: built.validated.backend,
            image: built.image,
          },
          deps.environment,
          deps.runCommand ?? runCommand,
        );
        if (problems.length)
          return json(
            { error: "Run prerequisites are not met", problems },
            412,
          );
        const started = await supervisor.start({
          agent_type: built.agent_type,
          task: built.task,
          profile: built.profile,
          backend: built.validated.backend,
          image: built.image,
          task_timeout_ms: built.validated.budget.task_timeout_ms,
        });
        return json({ run_id: started.run_id }, 202);
      } catch (error) {
        if (error instanceof TaskError)
          return json({ error: error.message, issues: error.issues }, 400);
        if (error instanceof RunLimitError)
          return json({ error: error.message, active: error.active }, 409);
        return errorResponse(error, "Starting run");
      }
    },

    async list(): Promise<Response> {
      try {
        return json(await listRuns(supervisor));
      } catch (error) {
        return errorResponse(error, "Listing runs");
      }
    },

    async get(runId: string): Promise<Response> {
      try {
        const run = await readRun(supervisor, runId);
        return run ? json({ run }) : json({ error: "Run not found" }, 404);
      } catch (error) {
        return errorResponse(error, "Reading run");
      }
    },

    async cancel(runId: string): Promise<Response> {
      try {
        await supervisor.cancel(runId);
        return json({ run: await readRun(supervisor, runId) }, 202);
      } catch (error) {
        if (error instanceof NotRunningError)
          return json({ error: error.message }, 409);
        return errorResponse(error, "Cancelling run");
      }
    },

    async events(runId: string, request: Request): Promise<Response> {
      const after = parseAfter(request);
      if (after === null)
        return json(
          { error: "Last-Event-ID / after must be a sequence number" },
          400,
        );
      try {
        if (!(await readRun(supervisor, runId)))
          return json({ error: "Run not found" }, 404);
      } catch (error) {
        return errorResponse(error, "Reading run");
      }
      return new Response(
        traceStream({
          source: supervisor,
          runId,
          after,
          pollMs: deps.pollMs,
          signal: request.signal,
        }),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        },
      );
    },
  };
}
