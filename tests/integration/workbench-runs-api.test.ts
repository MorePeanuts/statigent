import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { imagesFromEnvironment } from "../../src/workbench/agents";
import type { CommandRunner } from "../../src/workbench/preflight";
import { createRunHandlers } from "../../src/workbench/service";
import { Supervisor } from "../../src/workbench/supervisor";
import { profile } from "../helpers/agent";

const FAKE_WORKER = resolve("tests/fixtures/workbench/fake-worker.ts");
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
  const handlers = createRunHandlers({
    supervisor,
    inputRoot,
    modelsPath,
    images: imagesFromEnvironment({}),
    environment,
    runCommand: dockerReady,
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
