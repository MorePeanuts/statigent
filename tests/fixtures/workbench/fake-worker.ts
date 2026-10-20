// Stand-in for src/workbench/worker.ts in supervisor tests: same arguments and exit protocol,
// no model or Docker. The task's `mode` field picks the behaviour under test.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
const runId = flag("--run-id");
const task = JSON.parse(readFileSync(flag("--task"), "utf8")) as {
  mode: string;
};

function report(status: string, reason: string, code: number): never {
  console.log(
    JSON.stringify({ run_id: runId, status, reason, record_error: false }),
  );
  process.exit(code);
}

// Keeps the process alive until a signal decides its fate.
const idle = () => setInterval(() => {}, 1000);

if (task.mode === "complete") report("completed", "analysis_accepted", 0);
else if (task.mode === "await-signal") {
  process.on("SIGTERM", () => report("cancelled", "cancelled", 2));
  console.error("ready");
  idle();
} else if (task.mode === "ignore-sigterm") {
  process.on("SIGTERM", () => console.error("ignoring SIGTERM"));
  console.error("ready");
  idle();
} else if (task.mode === "crash") {
  console.error("worker exploded before the agent started");
  process.exit(1);
} else if (task.mode === "environment")
  report("completed", JSON.stringify(Object.keys(process.env).sort()), 0);
else throw new Error(`unknown mode ${task.mode}`);
