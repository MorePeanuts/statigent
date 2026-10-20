import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseStrictOptions } from "../cli-options";
import { writeJson } from "../records/store";
import type { TraceEvent } from "./events";
import type { ResultSummary } from "./results";

// Explicit, paid end-to-end check of the workbench: it starts the real server, goes through the
// same HTTP API the browser uses and runs one real model task. It never runs as part of
// `bun run check` and never retries: one invocation, one run.

const TASK = "configs/tasks/collaboration-report.json";
const INPUT = "tests/fixtures/synthetic.csv";
const USAGE =
  "Usage: bun run test:smoke:workbench -- --model PROFILE_ID [--port PORT]";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function hasGroupMeans(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasGroupMeans);
  const record = value as Record<string, unknown>;
  if (
    typeof record.A === "number" &&
    typeof record.B === "number" &&
    Math.abs(record.A - 2) < 1e-9 &&
    Math.abs(record.B - 4) < 1e-9
  )
    return true;
  return Object.values(record).some(hasGroupMeans);
}

async function waitForServer(base: string, server: ChildProcess) {
  for (let i = 0; i < 240; i++) {
    if (server.exitCode !== null)
      throw new Error(`Workbench server exited (${server.exitCode})`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error("Workbench server did not become ready within 60 s");
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

/** Uploads the fixture as synthetic.csv, reusing an identical existing file. */
async function ensureInput(base: string, origin: Record<string, string>) {
  const bytes = await readFile(INPUT);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const listed = await json(await fetch(`${base}/api/inputs`));
  const existing = (listed.inputs as { name: string; sha256: string }[]).find(
    (file) => file.name === "synthetic.csv",
  );
  if (existing) {
    if (existing.sha256 !== digest)
      throw new Error(
        "Input area already holds a different synthetic.csv; remove it before the smoke run",
      );
    return;
  }
  const uploaded = await fetch(`${base}/api/inputs?name=synthetic.csv`, {
    method: "POST",
    headers: origin,
    body: bytes,
  });
  if (uploaded.status !== 201)
    throw new Error(`Upload failed: ${JSON.stringify(await json(uploaded))}`);
}

/** Follows the trace until the stream's end frame; returns the events and final status. */
async function follow(base: string, runId: string) {
  const response = await fetch(`${base}/api/runs/${runId}/events`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Event stream has no body");
  const decoder = new TextDecoder();
  const events: TraceEvent[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Event stream closed without an end frame");
    buffer += decoder.decode(value, { stream: true });
    for (
      let split = buffer.indexOf("\n\n");
      split !== -1;
      split = buffer.indexOf("\n\n")
    ) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (block.startsWith(":")) continue;
      const fields = new Map(
        block.split("\n").map((line) => {
          const at = line.indexOf(": ");
          return [line.slice(0, at), line.slice(at + 2)] as const;
        }),
      );
      const data = JSON.parse(fields.get("data") ?? "null");
      const event = fields.get("event");
      if (event === "trace") {
        events.push(data);
        if (
          ["model_response", "delegation", "result", "finish"].some(
            (k) => data.kind === k || data.type === k,
          )
        )
          console.log(
            `  #${data.seq} ${data.role ?? ""} ${data.summary}`.trim(),
          );
      } else if (event === "status") console.log(`  status: ${data.status}`);
      else if (event === "end") {
        await reader.cancel();
        return { events, status: String(data.status) };
      }
    }
  }
}

export async function workbenchSmoke(args: string[]): Promise<number> {
  const flags = parseStrictOptions(args, ["--model", "--port"], USAGE);
  const model = flags["--model"];
  if (!model) throw new Error(USAGE);
  const port = Number(flags["--port"] ?? "3199");
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
    throw new Error("Invalid --port");
  const base = `http://127.0.0.1:${port}`;
  const origin = { origin: base };
  const task = JSON.parse(await readFile(TASK, "utf8"));

  console.log(
    `Paid smoke: one ${task.organization} report task with ${model}; budget ${JSON.stringify(task.budget)}`,
  );
  // Same command as `bun run workbench`, spawned directly so SIGTERM reaches the server itself,
  // which forwards it to any live worker.
  const server = spawn(
    "bun",
    ["--bun", "next", "dev", "web", "-H", "127.0.0.1", "-p", String(port)],
    {
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  let runId: string | null = null;
  const interrupt = async () => {
    if (runId)
      await fetch(`${base}/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: origin,
      }).catch(() => undefined); // Best effort on Ctrl-C; the server shutdown also stops workers.
    server.kill("SIGTERM");
    process.exit(130);
  };
  process.once("SIGINT", () => void interrupt());

  const checks: Check[] = [];
  const check = (name: string, passed: boolean, detail = "") => {
    checks.push({ name, passed, detail });
    console.log(
      `${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`,
    );
  };
  let result: ResultSummary | null = null;
  try {
    await waitForServer(base, server);
    await ensureInput(base, origin);
    const submitted = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { ...origin, "content-type": "application/json" },
      body: JSON.stringify({
        agent_type: "eda",
        goal: task.goal,
        constraints: task.constraints,
        inputs: ["synthetic.csv"],
        model_profile: model,
        organization: task.organization,
        backend: "persistent-kernel",
        budget: task.budget,
        report: true,
      }),
    });
    const body = await json(submitted);
    if (submitted.status !== 202) {
      check("submission accepted", false, JSON.stringify(body));
      return 1;
    }
    runId = String(body.run_id);
    console.log(`run_id: ${runId}`);
    const { events, status } = await follow(base, runId);
    check("run completed", status === "completed", status);
    const seqs = events.map((e) => e.seq);
    check(
      "trace streamed in order without gaps",
      seqs.every((s, i) => s === i + 1),
      `${events.length} events`,
    );
    result = (await json(await fetch(`${base}/api/runs/${runId}/result`)))
      .result as ResultSummary;
    check("accepted analysis", result.complete === true, result.notice ?? "");
    check(
      "group means A=2, B=4 in findings",
      result.analysis?.findings.some((f) => hasGroupMeans(f.value)) ?? false,
    );
    check(
      "all evidence resolved",
      result.analysis?.findings.every((f) =>
        f.evidence.every((e) => e.kind !== "unknown"),
      ) ?? false,
    );
    const report = result.report;
    check("report delivered", Boolean(report), report?.source_path ?? "none");
    if (report) {
      const text = await fetch(
        `${base}/api/runs/${runId}/artifacts/${report.artifact_id}`,
      );
      check("report readable", text.ok, `HTTP ${text.status}`);
      check(
        "report has images",
        report.images.length > 0,
        `${report.images.length}`,
      );
      for (const image of report.images) {
        const response = await fetch(
          `${base}/api/runs/${runId}/artifacts/${image.artifact_id}`,
        );
        check(
          `image ${image.path} served as image`,
          response.ok &&
            (response.headers.get("content-type") ?? "").startsWith("image/"),
          response.headers.get("content-type") ?? `HTTP ${response.status}`,
        );
      }
    }
    const notebook = result.files.find((f) => f.kind === "notebook");
    check(
      "notebook exported",
      Boolean(notebook?.available),
      notebook?.path ?? "none",
    );
    if (notebook) {
      const response = await fetch(
        `${base}/api/runs/${runId}/files/${notebook.path}`,
      );
      check("notebook downloadable", response.ok, `HTTP ${response.status}`);
    }
  } catch (error) {
    check("smoke completed without errors", false, String(error));
  } finally {
    server.kill("SIGTERM");
    await new Promise((done) => server.once("exit", done));
  }
  const passed = checks.every((c) => c.passed);
  if (runId) {
    const directory = resolve("runs/workbench/smoke");
    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, `${runId}.json`), {
      run_id: runId,
      model,
      task: TASK,
      passed,
      checks,
      status: result?.status ?? null,
      cost: result?.cost ?? null,
      at: new Date().toISOString(),
    });
    console.log(`result: runs/workbench/smoke/${runId}.json`);
  }
  console.log(passed ? "Workbench smoke passed" : "Workbench smoke failed");
  return passed ? 0 : 1;
}

if (import.meta.main)
  workbenchSmoke(Bun.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
