import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROLE_PROMPT_VERSIONS,
  ROLE_PROMPTS,
} from "../../src/agent/collaboration-prompt";
import {
  type AgentResult,
  type RunOptions,
  runAgent,
} from "../../src/agent/run";
import { ModelFailure } from "../../src/models/client";
import { obj } from "../../src/models/validation";
import { exportNotebooks } from "../../src/records/notebook";
import {
  inspectModelJournal,
  readArtifact,
  readEvents,
  readManifest,
  sha256,
} from "../../src/records/store";
import {
  call,
  fakeRuntime,
  finish,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";
import { returned, twoSubtasks } from "../helpers/collaboration";

async function scenario(
  script: ConstructorParameters<typeof ScriptClient>[0],
  check: (
    result: AgentResult,
    client: ScriptClient,
    runtime: ReturnType<typeof fakeRuntime>,
  ) => Promise<void> | void,
  budget = {},
  statuses: Parameters<typeof fakeRuntime>[0] = [],
  overrides: Partial<RunOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "collaboration-"));
  const client = new ScriptClient(script),
    runtime = fakeRuntime(statuses);
  try {
    const result = await runAgent({
      task: { ...task, organization: "planner-executor", budget },
      profile,
      client,
      runRoot: root,
      createSession: runtime.createSession,
      export: (dir, _, status) => exportNotebooks(dir, async () => {}, status),
      ...overrides,
    });
    await check(result, client, runtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("two delegated subtasks keep executor history and isolate planner messages with exact total usage", async () => {
  await scenario(
    twoSubtasks,
    async (r, client, runtime) => {
      expect(r.status).toBe("completed");
      expect(runtime.state.codes).toEqual([
        "secret_state=2",
        "print(secret_state)",
      ]);
      expect(runtime.state.closed).toBe(1);
      for (const i of [0, 3, 6])
        expect(JSON.stringify(client.bodies[i])).not.toContain("secret_state");
      expect(JSON.stringify(client.bodies[4])).toContain("secret_state=2");
      expect(JSON.stringify(client.bodies[4])).toContain("accepted");
      for (const [index, prior] of [
        [1, 0],
        [4, 1],
      ]) {
        const body = client.bodies[index ?? -1];
        if (!body || !Array.isArray(body.messages))
          throw new Error("Missing messages");
        const users = body.messages.map(obj).filter((m) => m.role === "user");
        const delegation = obj(JSON.parse(String(users.at(-1)?.content)));
        expect(delegation.execution_context).toEqual({
          backend: "persistent-kernel",
          session_continues: prior === 1,
          prior_subtasks: prior,
          prior_executions: prior,
        });
      }
      const m = await readManifest(r.directory);
      for (const role of ["planner", "executor"] as const)
        expect(m.collaboration?.roles[role].prompt).toEqual({
          version: ROLE_PROMPT_VERSIONS[role],
          sha256: sha256(Buffer.from(ROLE_PROMPTS[role])),
        });
      expect(m.tokens).toMatchObject({ attempts: 7, total_tokens: 105 });
      expect(m.collaboration?.roles.planner.tokens.attempts).toBe(3);
      expect(m.collaboration?.roles.executor.tokens.attempts).toBe(4);
      expect(m.collaboration?.subtasks.map((s) => s.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(
        (await inspectModelJournal(r.directory)).unresolved_attempts,
      ).toEqual([]);
      const events = await readEvents(r.directory);
      expect(
        events.filter((e) => e.type === "dispatch").map((e) => e.role),
      ).toEqual(["executor", "executor"]);
      expect(
        new Set(
          events.filter((e) => e.type === "dispatch").map((e) => e.subtask_id),
        ).size,
      ).toBe(2);
    },
    { executions: 2 },
  );
});

test("partial results return to planner; unseen evidence and role violations are rejected", async () => {
  await scenario(
    (b, i) => {
      if (i === 0 || i === 3)
        return reply([
          call("delegate_analysis", { task: "Check", constraints: [] }),
        ]);
      if (i === 1)
        return reply([
          returned(b, [], {
            status: "needs_clarification",
            findings: [],
            methods: [],
            diagnostic: "Select metric",
          }),
        ]);
      if (i === 2)
        return reply([call("execute_python", { code: "FORBIDDEN" })]);
      if (i === 4) return reply([call("execute_python", { code: "x=1" })]);
      if (i === 5) return reply([finish("cell-1")]); // executor cannot finish
      if (i === 6) return reply([returned(b, ["cell-1"])]);
      if (i === 7) return reply([finish("cell-999")]);
      return reply([finish("cell-1")]);
    },
    async (r, client, runtime) => {
      expect(r.status).toBe("completed");
      expect(runtime.state.codes).toEqual(["x=1"]);
      expect(JSON.stringify(client.bodies[2])).toContain("Select metric");
    },
    { action_corrections: 3 },
  );
});

test("global attempts, unknown consumption and code faults cannot be reset at role boundaries", async () => {
  await scenario(
    twoSubtasks,
    (r, c) => {
      expect(r.status).toBe("budget_exhausted");
      expect(c.bodies).toHaveLength(3);
    },
    { model_attempts: 3 },
  );
  await scenario(
    (b, i) =>
      i === 1
        ? reply([call("execute_python", { code: "NO" })], { usage: null })
        : twoSubtasks(b, i),
    (r, c, rt) => {
      expect(r.reason).toBe("accounting_incomplete");
      expect(c.bodies).toHaveLength(2);
      expect(rt.state.codes).toEqual([]);
    },
  );
  await scenario(
    twoSubtasks,
    (r, c) => {
      expect(r.reason).toBe("execution_state_unavailable");
      expect(c.bodies).toHaveLength(2);
    },
    {},
    [{ kernel_available: false }],
  );
  await scenario(
    twoSubtasks,
    (r, c) => {
      expect(r.reason).toBe("code_repairs_exhausted");
      expect(c.bodies).toHaveLength(2);
    },
    { code_repairs: 0 },
    [{ status: "error" }],
  );
});

test("retry use is shared and executor errors are absent from planner history", async () => {
  let n = 0;
  await scenario(
    (b, i) => {
      if (i === 1)
        throw new ModelFailure("rate_limited", "not_generated", true);
      const index = n++;
      if (index === 2)
        return reply([call("execute_python", { code: "repaired_state=2" })]);
      return twoSubtasks(b, index > 2 ? index - 1 : index);
    },
    async (r, c) => {
      expect(r.status).toBe("completed");
      const manifest = await readManifest(r.directory);
      expect(manifest.tokens).toMatchObject({ attempts: 9, total_tokens: 120 });
      const plannerRequests = (await readEvents(r.directory)).filter(
        (e) => e.type === "model_request" && e.role === "planner",
      );
      for (const e of plannerRequests)
        expect(
          (await readArtifact(r.directory, e.content_ref)).toString(),
        ).not.toContain("PRIVATE_STACK");
      expect(JSON.stringify(c.bodies)).toContain("PRIVATE_STACK");
    },
    {},
    [{ status: "error", preview: "PRIVATE_STACK" }],
  );
});

test("cancellation during executor model request stops before dispatch", async () => {
  const controller = new AbortController();
  await scenario(
    async (b, i) => {
      if (i === 1) {
        controller.abort();
        return reply([call("execute_python", { code: "late" })]);
      }
      return twoSubtasks(b, i);
    },
    (r, c, rt) => {
      expect(r.status).toBe("cancelled");
      expect(c.bodies).toHaveLength(2);
      expect(rt.state.codes).toEqual([]);
    },
    {},
    [],
    { signal: controller.signal },
  );
});

test("planner may only finish with references that a result actually exposed", async () => {
  await scenario(
    (b, i) => {
      if (i === 0) return twoSubtasks(b, 0);
      if (i === 1 || i === 2)
        return reply([call("execute_python", { code: "x=1" })]);
      if (i === 3) return reply([returned(b, ["cell-1"])]);
      return reply([finish("cell-2")]);
    },
    (r) => expect(r.reason).toBe("action_corrections_exhausted"),
    { action_corrections: 0 },
  );
});
