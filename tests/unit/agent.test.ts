import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunOptions, runAgent } from "../../src/agent/run";
import { ModelFailure } from "../../src/models/client";
import { exportNotebooks } from "../../src/records/notebook";
import {
  readArtifact,
  readEvents,
  readManifest,
} from "../../src/records/store";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";

async function scenario(
  script: ConstructorParameters<typeof ScriptClient>[0],
  check: (
    result: Awaited<ReturnType<typeof runAgent>>,
    client: ScriptClient,
    runtime: ReturnType<typeof fakeRuntime>,
  ) => Promise<void> | void,
  budget = {},
  overrides: Partial<RunOptions> = {},
  statuses: Parameters<typeof fakeRuntime>[0] = [],
) {
  const root = await mkdtemp(join(tmpdir(), "statigent-agent-"));
  const client = new ScriptClient(script);
  const runtime = fakeRuntime(statuses);
  try {
    const result = await runAgent({
      task: { ...task, budget },
      profile,
      runRoot: root,
      client,
      createSession: runtime.createSession,
      export: (dir, _, status) => exportNotebooks(dir, async () => {}, status),
      ...overrides,
    });
    await check(result, client, runtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("multi-step action, durable intent, tools, feedback, finish with final execution quota", async () => {
  await scenario(
    (body, i) =>
      i < 2
        ? reply([
            call("execute_python", { code: i === 0 ? "x=1" : "print(x)" }),
          ])
        : reply([finish(String(lastFeedback(body).cell_id))]),
    async (result, client, runtime) => {
      expect(result.status).toBe("completed");
      expect(runtime.state.codes).toEqual(["x=1", "print(x)"]);
      expect(runtime.state.closed).toBe(1);
      const manifest = await readManifest(result.directory);
      expect(manifest.tokens).toMatchObject({
        attempts: 3,
        total_tokens: 45,
        currency_cost: "not_computed",
      });
      expect(manifest.replay.eligible).toBe(true);
      const events = await readEvents(result.directory);
      expect(events.filter((e) => e.type === "run_finished")).toHaveLength(1);
      const request = events.find((e) => e.type === "model_request");
      expect(request).toBeDefined();
      expect(
        await readArtifact(result.directory, request?.content_ref),
      ).toBeDefined();
      expect(
        events.filter((e) => e.type === "tool_validation" && e.cell_id),
      ).toHaveLength(2);
      expect(JSON.stringify(client.bodies)).not.toContain("fake-key-agent");
      expect(JSON.stringify(client.bodies)).not.toContain(process.cwd());
      expect(
        await readFile(join(result.directory, "analysis.md"), "utf8"),
      ).toContain("cell-2");
    },
    { executions: 2 },
  );
});
test("invalid mixed/unknown/JSON actions never execute and use correction quota", async () => {
  for (const calls of [
    [call("execute_python", { code: "bad" }), finish("invented")],
    [call("host_shell", { code: "bad" })],
    [call("execute_python", "bad-json")],
  ])
    await scenario(
      () => reply(calls),
      (result, _, runtime) => {
        expect(result.status).toBe("failed");
        expect(runtime.state.codes).toHaveLength(0);
      },
      { action_corrections: 0 },
    );
  await scenario(
    () => reply(),
    (result, client, runtime) => {
      expect(result.reason).toBe("action_corrections_exhausted");
      expect(client.bodies).toHaveLength(3);
      expect(runtime.state.codes).toHaveLength(0);
    },
  );
});
test("duplicate ids, truncated response, missing usage fail without code", async () => {
  for (const raw of [
    reply([
      call("execute_python", { code: "bad" }, "same"),
      call("execute_python", { code: "bad" }, "same"),
    ]),
    reply([call("execute_python", { code: "bad" })], { usage: null }),
    reply(undefined, {
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: {
            role: "assistant",
            content: "partial",
            reasoning_content: "r",
          },
        },
      ],
    }),
  ])
    await scenario(
      () => raw,
      (result, _, runtime) => {
        expect(result.status).toBe("failed");
        expect(runtime.state.codes).toHaveLength(0);
      },
    );
  await scenario(
    () => reply([call("execute_python", { code: "once" }, "repeated")]),
    (result, _, runtime) => {
      expect(result.reason).toBe("duplicate_tool_id");
      expect(runtime.state.codes).toHaveLength(1);
    },
  );
});
test("ordinary errors repair with fresh cells and reset consecutive counter", async () => {
  await scenario(
    (body, i) =>
      i < 4
        ? reply([call("execute_python", { code: `cell${i}` })])
        : reply([finish(String(lastFeedback(body).cell_id))]),
    async (result, _, runtime) => {
      expect(result.status).toBe("completed");
      expect(runtime.state.codes).toHaveLength(4);
      expect((await readManifest(result.directory)).replay.reasons).toContain(
        "cell_error",
      );
    },
    { code_repairs: 1 },
    {},
    [
      { status: "error", partial_state_possible: true },
      { status: "ok" },
      { status: "error" },
      { status: "ok" },
    ],
  );
  await scenario(
    () => reply([call("execute_python", { code: "bad" })]),
    (result, _, runtime) => {
      expect(result.reason).toBe("code_repairs_exhausted");
      expect(runtime.state.codes).toHaveLength(3);
    },
    {},
    {},
    [{ status: "error" }, { status: "error" }, { status: "error" }],
  );
  for (const status of [
    { status: "kernel_lost", kernel_available: false },
    { status: "output_limit_exceeded", persistence_complete: false },
  ] as const)
    await scenario(
      () => reply([call("execute_python", { code: "bad" })]),
      (result, client, runtime) => {
        expect(result.status).toBe("failed");
        expect(client.bodies).toHaveLength(1);
        expect(runtime.state.codes).toHaveLength(1);
      },
      {},
      {},
      [status],
    );
});
test("budget preflight, actual token overage, attempts and executions", async () => {
  await scenario(
    () => reply([call("execute_python", { code: "x" })]),
    (result, client) => {
      expect(result.reason).toBe("token_preflight");
      expect(client.bodies).toHaveLength(0);
    },
    { total_tokens: 1 },
  );
  await scenario(
    () =>
      reply([call("execute_python", { code: "x" })], {
        usage: { prompt_tokens: 100001, completion_tokens: 1 },
      }),
    async (result, _, runtime) => {
      expect(result.status).toBe("budget_exhausted");
      expect(runtime.state.codes).toHaveLength(0);
      expect((await readManifest(result.directory)).tokens).toMatchObject({
        total_tokens: 100002,
      });
    },
  );
  await scenario(
    () => reply([call("execute_python", { code: "x" })]),
    (result, client) => {
      expect(result.reason).toBe("model_attempts");
      expect(client.bodies).toHaveLength(1);
    },
    { model_attempts: 1 },
  );
  await scenario(
    () => reply([call("execute_python", { code: "x" })]),
    (result, client, runtime) => {
      expect(result.reason).toBe("executions");
      expect(client.bodies).toHaveLength(2);
      expect(runtime.state.codes).toHaveLength(1);
    },
    { executions: 1 },
  );
});
test("429 bounded retry records every attempt, uncertain failures do not retry", async () => {
  await scenario(
    () => {
      throw new ModelFailure("rate_limited", "not_generated", true);
    },
    async (result, client) => {
      expect(result.status).toBe("failed");
      expect(client.bodies).toHaveLength(3);
      const manifest = await readManifest(result.directory);
      expect(manifest.tokens).toMatchObject({
        attempts: 3,
        unknown_attempts: 0,
      });
      expect(
        (await readEvents(result.directory)).filter(
          (e) => e.type === "model_failure",
        ),
      ).toHaveLength(3);
    },
  );
  await scenario(
    () => {
      throw new ModelFailure("disconnect", "unknown");
    },
    async (result, client) => {
      expect(result.reason).toBe("accounting_incomplete");
      expect(client.bodies).toHaveLength(1);
      expect((await readManifest(result.directory)).tokens).toMatchObject({
        unknown_attempts: 1,
        status: "unknown",
      });
    },
  );
});
test("deadline/cancel while model waiting reject late action and close", async () => {
  const controller = new AbortController();
  await scenario(
    async () => {
      controller.abort();
      await Bun.sleep(5);
      return reply([call("execute_python", { code: "late" })]);
    },
    (result, _, runtime) => {
      expect(result.status).toBe("cancelled");
      expect(runtime.state.codes).toHaveLength(0);
    },
    {},
    { signal: controller.signal },
  );
  await scenario(
    async () => {
      await Bun.sleep(100);
      return reply([call("execute_python", { code: "late" })]);
    },
    (result, _, runtime) => {
      expect(result.status).toBe("timed_out");
      expect(runtime.state.codes).toHaveLength(0);
    },
    { task_timeout_ms: 70 },
  );
});
test("finish must cite successful current evidence, export failure cannot succeed", async () => {
  await scenario(
    () => reply([finish("foreign-cell")]),
    (result) => {
      expect(result.status).toBe("failed");
    },
    { action_corrections: 0 },
  );
  await scenario(
    (_, i) =>
      i === 0
        ? reply([call("execute_python", { code: "x" })])
        : reply([finish("foreign-cell")]),
    (result) => {
      expect(result.status).toBe("failed");
    },
    { action_corrections: 0 },
  );
  await scenario(
    (body, i) =>
      i === 0
        ? reply([call("execute_python", { code: "x" })])
        : reply([finish(String(lastFeedback(body).cell_id))]),
    (result) => {
      expect(result.status).toBe("failed");
      expect(result.analysis).not.toBeNull();
    },
    {},
    {
      export: async () => {
        throw new Error("disk failure");
      },
    },
  );
});
test("trace persistence failure stops before HTTP", async () => {
  await scenario(
    () => reply(),
    (result, client, runtime) => {
      expect(result.status).toBe("failed");
      expect(client.bodies).toHaveLength(0);
      expect(runtime.state.closed).toBe(1);
      expect(result.record_error).toBe(true);
    },
    { max_trace_bytes: 1 },
  );
});

test("switching two model profiles does not change loop; request is durable before send", async () => {
  for (const selected of [
    profile,
    {
      ...profile,
      id: "generic-test",
      provider: "generic" as const,
      model: "custom-x",
      capabilities: { tool_calls: true as const, thinking: false },
      generation: { max_output_tokens: 500 },
    },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "statigent-switch-"));
    const runtime = fakeRuntime();
    const client = new ScriptClient(async (body, i) => {
      const rec = runtime.state.recorder;
      if (!rec) throw new Error("No recorder");
      expect(
        (await readEvents(rec.directory)).filter(
          (e) => e.type === "model_request",
        ),
      ).toHaveLength(i + 1);
      expect(body.model).toBe(selected.model);
      return i === 0
        ? reply([call("execute_python", { code: "x=1" })])
        : reply([finish(String(lastFeedback(body).cell_id))]);
    }, selected);
    try {
      expect(
        (
          await runAgent({
            task,
            profile: selected,
            runRoot: root,
            client,
            createSession: runtime.createSession,
            export: (dir, _, status) =>
              exportNotebooks(dir, async () => {}, status),
          })
        ).status,
      ).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("record I/O failure after response prevents execution; cleanup failure rejects completion", async () => {
  const { RunRecorder } = await import("../../src/records/store");
  let journal = "";
  await scenario(
    async () => {
      await rm(journal);
      await mkdir(journal);
      return reply([call("execute_python", { code: "forbidden" })]);
    },
    (result, client, runtime) => {
      expect(result.status).toBe("failed");
      expect(client.bodies).toHaveLength(1);
      expect(runtime.state.codes).toHaveLength(0);
    },
    {},
    {
      createRecorder: async (options) => {
        const rec = await RunRecorder.create(options);
        journal = join(rec.directory, "events.jsonl");
        return rec;
      },
    },
  );
  const root = await mkdtemp(join(tmpdir(), "statigent-cleanup-fail-"));
  const runtime = fakeRuntime();
  const client = new ScriptClient((body, i) =>
    i === 0
      ? reply([call("execute_python", { code: "x" })])
      : reply([finish(String(lastFeedback(body).cell_id))]),
  );
  try {
    const result = await runAgent({
      task,
      profile,
      runRoot: root,
      client,
      createSession: async (config, rec) => {
        const session = await runtime.createSession(config, rec);
        return { ...session, closeResult: { status: "failed" } };
      },
      export: (dir, _, status) => exportNotebooks(dir, async () => {}, status),
    });
    expect(result.status).toBe("failed");
    expect(result.analysis).not.toBeNull();
    expect(
      (await readEvents(result.directory)).filter(
        (e) => e.type === "run_finished",
      ),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
