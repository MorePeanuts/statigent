import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE_PROMPTS } from "../../src/agent/collaboration-prompt";
import { SYSTEM_PROMPT } from "../../src/agent/prompt";
import { runAgent } from "../../src/agent/run";
import {
  checkSmokeMeans,
  loadScriptSmoke,
  scriptSmokeMain,
} from "../../src/agent/script-smoke";
import { ScriptSession } from "../../src/execution/script-session";
import { readManifest, sha256 } from "../../src/records/store";
import {
  call,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";
import { returned } from "../helpers/collaboration";
import { FakeScriptTransport } from "../helpers/script";

test("script smoke verifies CSV values independently of row order and extra columns", () => {
  expect(checkSmokeMeans('group,mean,n\n"B",4,2\n"A",2,2\n')).toBe(true);
  expect(checkSmokeMeans("mean,group\n2,A\n4,B\n")).toBe(true);
  expect(checkSmokeMeans("group,mean,n\nA,9,2\nB,8,2\n")).toBe(false);
  expect(checkSmokeMeans("group,mean\nA,2\nA,4\n")).toBe(false);
  expect(checkSmokeMeans("group,mean\nA,2\nB,4\nC,6\n")).toBe(false);
});

for (const organization of ["single", "planner-executor"] as const)
  test(`fresh ${organization} keeps history, valid evidence and global budget`, async () => {
    const root = await mkdtemp(join(tmpdir(), "script-agent-"));
    const transport = new FakeScriptTransport();
    let ref = "";
    const client = new ScriptClient((body, index) => {
      if (organization === "planner-executor") {
        if (index === 0 || index === 3)
          return reply([
            call("delegate_analysis", { task: "compute", constraints: [] }),
          ]);
        if (index === 1 || index === 4) {
          if (index === 4) {
            const history = JSON.stringify(body.messages);
            expect(history).toContain("print(42)");
            expect(history).toContain("memory_preserved");
            expect(history).not.toContain("session_continues");
          }
          return reply([call("execute_python", { code: "print(42)" })]);
        }
        if (index === 2 || index === 5) {
          ref = String(lastFeedback(body).execution_id);
          return reply([returned(body, [ref])]);
        }
        expect(JSON.stringify(body.messages)).not.toContain("print(42)");
        return reply([finish(ref)]);
      }
      if (index < 2)
        return reply([call("execute_python", { code: "print(42)" })]);
      expect(JSON.stringify(body.messages)).toContain("memory_preserved");
      return reply([finish(String(lastFeedback(body).execution_id))]);
    });
    const result = await runAgent({
      task: {
        ...task,
        backend: "fresh-script",
        organization,
        budget: { ...task.budget, executions: 2 },
      },
      profile,
      client,
      runRoot: root,
      createSession: (c, r) => ScriptSession.create(c, r, transport),
    });
    expect(result.status).toBe("completed");
    const manifest = await readManifest(result.directory);
    expect(
      manifest.agent !== "not_applicable" && manifest.agent?.executions,
    ).toBe(2);
    expect(
      manifest.tokens !== "not_applicable" && manifest.tokens.attempts,
    ).toBe(organization === "single" ? 3 : 7);
    expect(
      manifest.prompt !== "not_applicable" && manifest.prompt.version,
    ).toContain("script");
  });
test("script execution quota, unknown usage, evidence rejection and errors have bounded termination", async () => {
  for (const mode of ["quota", "unknown", "invalid", "repair"]) {
    const transport = new FakeScriptTransport();
    if (mode === "repair") {
      const finish = transport.finish.bind(transport);
      transport.finish = (r) => finish(r, "error");
    }
    const client = new ScriptClient((_body, index) =>
      mode === "unknown"
        ? reply(undefined, { usage: null })
        : mode === "invalid" && index > 0
          ? reply([finish("not-evidence")])
          : reply([call("execute_python", { code: "print(42)" })]),
    );
    const result = await runAgent({
      task: {
        ...task,
        backend: "fresh-script",
        budget: {
          ...task.budget,
          executions: 2,
          code_repairs: 1,
          action_corrections: 1,
        },
      },
      profile,
      client,
      runRoot: await mkdtemp(join(tmpdir(), "script-budget-")),
      createSession: (c, r) => ScriptSession.create(c, r, transport),
    });
    expect(result.status).not.toBe("completed");
    expect(
      transport.requests.filter((r) => r.type === "execute").length,
    ).toBeLessThanOrEqual(2);
    expect(client.bodies.length).toBeLessThanOrEqual(3);
  }
});
test("persistent prompt hashes match the frozen pre-change source", () => {
  // Verified against 1c870af; constants keep shallow CI checkouts independent of Git history.
  expect(sha256(Buffer.from(SYSTEM_PROMPT))).toBe(
    "e803e08c8e1eceeada50f4a2c722a80ea1070de9f682a6620f3ac697f4b1be52",
  );
  expect(sha256(Buffer.from(ROLE_PROMPTS.planner))).toBe(
    "e77ad01f710b53c7d42f5d64a909cc54dccf68515c8c98ef03bc2c13cd1df381",
  );
  expect(sha256(Buffer.from(ROLE_PROMPTS.executor))).toBe(
    "618ba28c706c109788dd6614d20ff8ed1de24ce47e9921d6f34456e0edc7ee84",
  );
});
test("smoke requires explicit organization, preflight sends no model requests and never auto-reruns failure", async () => {
  for (const args of [
    [],
    ["--organization", "both"],
    ["--organization", "single", "--preflight", "--preflight"],
  ])
    await expect(loadScriptSmoke(args)).rejects.toThrow();
  let calls = 0;
  const image = async () => ({
    runtime_labels: { "org.statigent.fresh-script": "2" },
  });
  const root = await mkdtemp(join(tmpdir(), "script-smoke-"));
  const run = async () => {
    calls++;
    return {
      run_id: "first",
      directory: root,
      status: "failed" as const,
      reason: "first failure",
      analysis: null,
      record_error: false,
    };
  };
  for (const organization of ["single", "planner-executor"])
    expect(
      await scriptSmokeMain(["--organization", organization, "--preflight"], {
        run,
        image,
      }),
    ).toMatchObject({ model_calls: 0, organization });
  expect(calls).toBe(0);
  await expect(
    scriptSmokeMain(["--organization", "single"], {
      run,
      image,
      check: async () => {
        throw Error("first failure");
      },
    }),
  ).rejects.toThrow("first failure");
  expect(calls).toBe(1);
  expect(await readFile(join(root, "smoke-result.json"), "utf8")).toContain(
    "first failure",
  );
});

test("parent cancellation and recorder fault stop script work without budget reset", async () => {
  for (const mode of ["cancel", "record"]) {
    const controller = new AbortController();
    const transport = new FakeScriptTransport();
    transport.autoFinish = false;
    const client = new ScriptClient(() =>
      reply([call("execute_python", { code: "while True: pass" })]),
    );
    const root = await mkdtemp(join(tmpdir(), "script-stop-"));
    const result = await runAgent({
      task: { ...task, backend: "fresh-script" },
      profile,
      client,
      runRoot: root,
      signal: controller.signal,
      createSession: async (c, r) => {
        const session = await ScriptSession.create(c, r, transport);
        if (mode === "cancel") setTimeout(() => controller.abort(), 20);
        else {
          const original = r.onEvent.bind(r);
          r.onEvent = async (e) => {
            if (e.type === "dispatch") throw Error("record failed");
            return original(e);
          };
        }
        return session;
      },
    });
    expect(result.status).toBe(mode === "cancel" ? "cancelled" : "failed");
    expect(client.bodies).toHaveLength(1);
    expect(transport.requests.filter((r) => r.type === "execute")).toHaveLength(
      mode === "cancel" ? 1 : 0,
    );
    expect(transport.stops).toBeGreaterThan(0);
  }
});
