// Stand-in for src/workbench/worker.ts in supervisor tests: same arguments and exit protocol,
// no real model or Docker. The behaviour comes from the task's `mode` field, or from a
// `mode:<name>` marker in its goal when the task was assembled from a form submission.
import { readFileSync } from "node:fs";
import { WORKER_EXIT } from "../../../src/workbench/protocol";
import { workerMain } from "../../../src/workbench/worker";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  reply,
  ScriptClient,
} from "../../helpers/agent";

const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
const runId = flag("--run-id");
const task = JSON.parse(readFileSync(flag("--task"), "utf8")) as {
  mode?: string;
  goal?: string;
};
// FAKE_WORKER_MODE lets a wrapper drive fixed tasks (e.g. the workbench smoke) through the stand-in.
const mode =
  task.mode ??
  /mode:(\S+)/.exec(task.goal ?? "")?.[1] ??
  process.env.FAKE_WORKER_MODE;

function report(status: string, reason: string, code: number): never {
  console.log(
    JSON.stringify({ run_id: runId, status, reason, record_error: false }),
  );
  process.exit(code);
}

// Keeps the process alive until a signal decides its fate.
const idle = () => setInterval(() => {}, 1000);

/** The real agent loop with a scripted model and an in-memory execution session. */
async function agent(waitForCancel: boolean) {
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  const client = new ScriptClient(async (body, i) => {
    if (waitForCancel) {
      console.error("ready");
      while (!controller.signal.aborted) await Bun.sleep(10);
      return reply([call("execute_python", { code: "late" })]);
    }
    return i === 0
      ? reply([call("execute_python", { code: "x = 1" })])
      : reply([finish(String(lastFeedback(body).cell_id))]);
  });
  const summary = await workerMain(args, controller.signal, {
    client,
    createSession: fakeRuntime().createSession,
  });
  report(
    summary.status,
    summary.reason,
    summary.status === "completed"
      ? WORKER_EXIT.completed
      : WORKER_EXIT.not_completed,
  );
}

if (mode === "complete") report("completed", "analysis_accepted", 0);
else if (mode === "await-signal") {
  process.on("SIGTERM", () => report("cancelled", "cancelled", 2));
  console.error("ready");
  idle();
} else if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => console.error("ignoring SIGTERM"));
  console.error("ready");
  idle();
} else if (mode === "crash") {
  console.error("worker exploded before the agent started");
  process.exit(1);
} else if (mode === "environment")
  report("completed", JSON.stringify(Object.keys(process.env).sort()), 0);
else if (mode === "agent-complete") await agent(false);
else if (mode === "agent-wait") await agent(true);
else throw new Error(`unknown mode ${mode}`);
