import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { imagesFromEnvironment } from "../../src/workbench/agents";
import type { CommandRunner } from "../../src/workbench/preflight";
import { createRunHandlers } from "../../src/workbench/service";
import { Supervisor } from "../../src/workbench/supervisor";
import { profile } from "../helpers/agent";

const FAKE_WORKER = resolve("tests/fixtures/workbench/fake-worker.ts");

// A failing test must not leave stand-in workers running (some wait forever for a signal).
const created: Supervisor[] = [];
afterEach(() => {
  for (const s of created.splice(0)) s.shutdown("SIGKILL");
});
const KEY = { [profile.api_key_env]: "sk-test" };

// Docker answers as if the daemon and image were present; no container is ever started.
const dockerReady: CommandRunner = async (_command, args) => ({
  code: 0,
  stdout: args[0] === "version" ? "28.0.1" : "null",
  stderr: "",
});

async function service(environment: Record<string, string | undefined> = KEY) {
  const root = await mkdtemp(join(tmpdir(), "workbench-api-"));
  const inputRoot = join(root, "inputs");
  await mkdir(inputRoot);
  await writeFile(join(inputRoot, "synthetic.csv"), "group,value\nA,1\nB,3\n");
  const modelsPath = join(root, "models.json");
  await writeFile(modelsPath, JSON.stringify([profile]));
  const supervisor = new Supervisor({
    root,
    cwd: process.cwd(),
    modelsPath,
    workerCommand: [process.execPath, "--no-env-file", FAKE_WORKER],
    maxRuns: 1,
    cancelGraceMs: 5_000,
    watchdogGraceMs: 60_000,
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...environment,
    },
  });
  created.push(supervisor);
  const handlers = createRunHandlers({
    supervisor,
    inputRoot,
    modelsPath,
    images: imagesFromEnvironment({}),
    environment,
    runCommand: dockerReady,
    pollMs: 20,
  });
  return { supervisor, handlers };
}

function submit(body: unknown) {
  return new Request("http://127.0.0.1:3100/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const payload = (goal: string) => ({
  agent_type: "eda",
  goal,
  inputs: ["synthetic.csv"],
  model_profile: profile.id,
});

async function ready(supervisor: Supervisor, runId: string) {
  for (let i = 0; i < 500; i++) {
    if (supervisor.current(runId)?.stderr_tail.includes("ready")) return;
    await Bun.sleep(10);
  }
  throw new Error("worker never became ready");
}

test("submit, observe and finish a run through the handlers", async () => {
  const { supervisor, handlers } = await service();
  const accepted = await handlers.submit(
    submit(payload("mode:agent-complete")),
  );
  expect(accepted.status).toBe(202);
  const { run_id } = (await accepted.json()) as { run_id: string };
  await supervisor.waitForExit(run_id);
  const detail = await handlers.get(run_id);
  expect(detail.status).toBe(200);
  expect(((await detail.json()) as { run: unknown }).run).toMatchObject({
    run_id,
    status: "completed",
    goal: "mode:agent-complete",
    model: profile.id,
    cancellable: false,
  });
  const listed = (await (await handlers.list()).json()) as {
    runs: { run_id: string }[];
  };
  expect(listed.runs.map((r) => r.run_id)).toEqual([run_id]);
});

test("cancel ends a live run as cancelled and frees the slot", async () => {
  const { supervisor, handlers } = await service();
  const { run_id } = (await (
    await handlers.submit(submit(payload("mode:agent-wait")))
  ).json()) as { run_id: string };
  await ready(supervisor, run_id);
  const running = (await (await handlers.get(run_id)).json()) as {
    run: { status: string; cancellable: boolean };
  };
  // The stand-in session never reports container readiness, so the record stays "starting".
  expect(["starting", "running"]).toContain(running.run.status);
  expect(running.run.cancellable).toBe(true);

  const second = await handlers.submit(submit(payload("mode:agent-complete")));
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ active: [run_id] });

  const cancelled = await handlers.cancel(run_id);
  expect(cancelled.status).toBe(202);
  await supervisor.waitForExit(run_id);
  expect(
    ((await (await handlers.get(run_id)).json()) as { run: unknown }).run,
  ).toMatchObject({ status: "cancelled", cancellable: false });
  expect((await handlers.cancel(run_id)).status).toBe(409);
});

test("invalid submissions are refused with field issues and start nothing", async () => {
  const { supervisor, handlers } = await service();
  const malformed = await handlers.submit(submit("{"));
  expect(malformed.status).toBe(400);
  const invalid = await handlers.submit(
    submit({ ...payload(""), budget: { executions: -1 } }),
  );
  expect(invalid.status).toBe(400);
  expect(
    ((await invalid.json()) as { issues: { field: string }[] }).issues.map(
      (i) => i.field,
    ),
  ).toEqual(["goal", "budget.executions"]);
  const unknownType = await handlers.submit(
    submit({ ...payload("x"), agent_type: "modeling" }),
  );
  expect(unknownType.status).toBe(400);
  expect(supervisor.activeRuns()).toEqual([]);
  expect((await (await handlers.list()).json()) as unknown).toEqual({
    runs: [],
    errors: [],
  });
});

test("unmet prerequisites are reported before any run exists", async () => {
  const { supervisor, handlers } = await service({});
  const refused = await handlers.submit(submit(payload("mode:complete")));
  expect(refused.status).toBe(412);
  expect(await refused.json()).toMatchObject({
    problems: [{ code: "model_key_missing" }],
  });
  expect(supervisor.activeRuns()).toEqual([]);
});

test("unknown runs answer 404 and are not cancellable", async () => {
  const { handlers } = await service();
  expect((await handlers.get("missing")).status).toBe(404);
  expect((await handlers.get("../escape")).status).toBe(404);
  expect((await handlers.cancel("missing")).status).toBe(409);
});

interface Frame {
  id?: string;
  event: string;
  data: Record<string, unknown>;
}

/** Reads SSE frames until an `end` frame (or the stream closes); `onFrame` may act mid-stream. */
async function frames(
  response: Response,
  onFrame: (frame: Frame) => void | Promise<void> = () => {},
): Promise<Frame[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No body");
  const decoder = new TextDecoder();
  const seen: Frame[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return seen;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
      if (block.startsWith(":")) continue;
      const fields = Object.fromEntries(
        block.split("\n").map((line) => {
          const at = line.indexOf(": ");
          return [line.slice(0, at), line.slice(at + 2)];
        }),
      );
      const frame: Frame = {
        id: fields.id,
        event: fields.event ?? "message",
        data: JSON.parse(fields.data ?? "null"),
      };
      seen.push(frame);
      await onFrame(frame);
      if (frame.event === "end") {
        await reader.cancel();
        return seen;
      }
    }
  }
}

const eventsRequest = (runId: string, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:3100/api/runs/${runId}/events`, { headers });

test("the trace streams live and ends with the run's final status", async () => {
  const { supervisor, handlers } = await service();
  const { run_id } = (await (
    await handlers.submit(submit(payload("mode:agent-wait")))
  ).json()) as { run_id: string };
  const response = await handlers.events(run_id, eventsRequest(run_id));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  let cancelled = false;
  const seen = await frames(response, async (frame) => {
    // Cancel once the model call is visibly in flight.
    if (
      !cancelled &&
      frame.event === "trace" &&
      frame.data.type === "model_request"
    ) {
      cancelled = true;
      await handlers.cancel(run_id);
    }
  });
  const traces = seen.filter((f) => f.event === "trace");
  expect(traces.map((f) => Number(f.id))).toEqual(traces.map((_, i) => i + 1));
  expect(traces.map((f) => f.data.seq)).toEqual(traces.map((_, i) => i + 1));
  expect(traces.at(-1)?.data).toMatchObject({
    type: "run_finished",
    data: { status: "cancelled" },
  });
  const statuses = seen
    .filter((f) => f.event === "status")
    .map((f) => f.data.status);
  expect(["starting", "running"]).toContain(statuses[0] as string);
  expect(seen.at(-1)).toMatchObject({
    event: "end",
    data: { status: "cancelled", cancellable: false },
  });
  await supervisor.waitForExit(run_id);
});

test("reconnecting resumes after the last received event", async () => {
  const { supervisor, handlers } = await service();
  const { run_id } = (await (
    await handlers.submit(submit(payload("mode:agent-complete")))
  ).json()) as { run_id: string };
  await supervisor.waitForExit(run_id);
  const all = (
    await frames(await handlers.events(run_id, eventsRequest(run_id)))
  ).filter((f) => f.event === "trace");
  expect(all.length).toBeGreaterThan(4);
  const resumed = await frames(
    await handlers.events(
      run_id,
      eventsRequest(run_id, { "last-event-id": "3" }),
    ),
  );
  expect(resumed.filter((f) => f.event === "trace").map((f) => f.id)).toEqual(
    all.slice(3).map((f) => f.id),
  );
  const viaQuery = await frames(
    await handlers.events(
      run_id,
      new Request(
        `http://127.0.0.1:3100/api/runs/${run_id}/events?after=${all.length}`,
      ),
    ),
  );
  expect(viaQuery.map((f) => f.event)).toEqual(["status", "end"]);
});

test("stream requests are validated before streaming", async () => {
  const { handlers } = await service();
  expect(
    (await handlers.events("missing", eventsRequest("missing"))).status,
  ).toBe(404);
  expect(
    (await handlers.events("x", eventsRequest("x", { "last-event-id": "-1" })))
      .status,
  ).toBe(400);
});

test("a client that disconnects stops the stream without disturbing the run", async () => {
  const { supervisor, handlers } = await service();
  const { run_id } = (await (
    await handlers.submit(submit(payload("mode:agent-wait")))
  ).json()) as { run_id: string };
  const response = await handlers.events(run_id, eventsRequest(run_id));
  const reader = response.body?.getReader();
  await reader?.read();
  await reader?.cancel();
  expect(supervisor.isLive(run_id)).toBe(true);
  await ready(supervisor, run_id);
  await handlers.cancel(run_id);
  expect((await supervisor.waitForExit(run_id))?.summary?.status).toBe(
    "cancelled",
  );
});
