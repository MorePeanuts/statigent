import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import config from "../../configs/tasks/collaboration-report.json";
import { runAgent } from "../../src/agent/run";
import { deliverReport } from "../../src/evaluation/agents/statigent";
import { dockerCommand } from "../../src/execution/docker";
import { DockerSession } from "../../src/execution/session";
import { replayRun } from "../../src/records/replay";
import { readEvents, readManifest, sha256 } from "../../src/records/store";
import { call, profile, reply, ScriptClient } from "../helpers/agent";
import { collaborationScript } from "../helpers/collaboration-script";

const runRoot = resolve("runs/integration-collaboration");
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return Object.fromEntries(
    await Promise.all(
      files
        .filter((f) => f.isFile())
        .map(async (f) => {
          const path = join(f.parentPath, f.name);
          return [path, sha256(await readFile(path))];
        }),
    ),
  );
}
async function cleaned(runId: string) {
  expect(
    await dockerCommand([
      "ps",
      "-aq",
      "--filter",
      `label=org.statigent.run=${runId}`,
    ]),
  ).toBe("");
}

test("dual Docker sessions preserve cross-delegation state, isolate tasks, deliver report and replay immutably", async () => {
  let created = 0;
  const sessions: string[] = [];
  for (let n = 0; n < 2; n++) {
    const result = await runAgent({
      task: config,
      profile,
      runRoot,
      client: new ScriptClient(collaborationScript()),
      createSession: async (c, r) => {
        created++;
        const session = await DockerSession.create(c, r);
        sessions.push(session.sessionId);
        return session;
      },
    });
    expect(result.status, result.reason).toBe("completed");
    const manifest = await readManifest(result.directory);
    expect(manifest.collaboration?.subtasks.map((s) => s.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(manifest.timing.execution_count).toBe(2);
    const events = await readEvents(result.directory);
    expect(
      new Set(
        events.filter((e) => e.type === "dispatch").map((e) => e.session_id),
      ).size,
    ).toBe(1);
    expect(
      events
        .filter((e) => e.type === "finish")
        .map((e) => JSON.stringify(e.result))
        .join("\n"),
    ).toContain("[-2.0, 2.0]");
    await deliverReport(
      result.directory,
      result.analysis,
      "report.md",
      join(runRoot, `${result.run_id}-delivery`),
    );
    expect(result.analysis?.report?.images.length).toBe(1);
    const before = await snapshot(result.directory);
    if (n === 0) {
      const replay = await replayRun(result.directory, runRoot);
      expect(replay.status, replay.reasons.join(";")).toBe("passed");
      const replayManifest = await readManifest(replay.directory ?? "");
      expect(
        replayManifest.artifacts.some((a) => a.origin?.role === "planner"),
      ).toBe(false);
      expect(await snapshot(result.directory)).toEqual(before);
      await cleaned(replay.run_id ?? "");
    }
    await cleaned(result.run_id);
    console.log(
      JSON.stringify({
        kind: "collaboration_integration",
        run_id: result.run_id,
        task_index: n,
      }),
    );
  }
  expect(created).toBe(2);
  expect(new Set(sessions).size).toBe(2);
}, 180000);

test("dual Docker repair keeps private stack and state; completed analysis has unsupported strict replay", async () => {
  const client = new ScriptClient(collaborationScript(true));
  const result = await runAgent({ task: config, profile, runRoot, client });
  expect(result.status, result.reason).toBe("completed");
  const events = await readEvents(result.directory);
  expect(JSON.stringify(events)).toContain("SECRET_REPAIR_TRACE");
  expect(
    client.bodies
      .filter((b) => JSON.stringify(b.tools).includes('"delegate_analysis"'))
      .every(
        (b) => !JSON.stringify(b.messages).includes("SECRET_REPAIR_TRACE"),
      ),
  ).toBe(true);
  expect((await readManifest(result.directory)).replay.reasons).toContain(
    "cell_error",
  );
  expect((await replayRun(result.directory, runRoot)).status).toBe(
    "unsupported",
  );
  await cleaned(result.run_id);
}, 120000);

test("dual Docker cancellation reaches active execution and cleans the only session", async () => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await runAgent({
    task: config,
    profile,
    runRoot,
    signal: controller.signal,
    client: new ScriptClient((_, i) =>
      reply([
        i === 0
          ? call("delegate_analysis", { task: "Wait", constraints: [] })
          : call("execute_python", { code: "import time\ntime.sleep(30)" }),
      ]),
    ),
    createSession: async (c, r) => {
      const session = await DockerSession.create(c, r);
      return {
        get closeResult() {
          return session.closeResult;
        },
        close: () => session.close(),
        cancel: (id) => session.cancel(id),
        execute: (code, opts) => {
          timer = setTimeout(() => controller.abort(), 300);
          return session.execute(code, opts);
        },
      };
    },
  });
  clearTimeout(timer);
  expect(result.status, result.reason).toBe("cancelled");
  const events = await readEvents(result.directory);
  expect(events.filter((e) => e.type === "run_finished")).toHaveLength(1);
  expect(events.filter((e) => e.type === "dispatch")).toHaveLength(1);
  await cleaned(result.run_id);
}, 90000);
