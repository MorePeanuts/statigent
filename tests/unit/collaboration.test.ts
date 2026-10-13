import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROLE_PROMPT_VERSIONS,
  ROLE_PROMPTS,
} from "../../src/agent/collaboration-prompt";
import { diagnosticClosure } from "../../src/agent/completion";
import { validateTask } from "../../src/agent/config";
import {
  type AgentResult,
  type RunOptions,
  runAgent,
} from "../../src/agent/run";
import { validateConfig } from "../../src/execution/protocol";
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
  lastFeedback,
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

test("diagnostic closure reserves return/synthesis and rejects further work without losing evidence", async () => {
  await scenario(
    (body, i) => {
      if (i === 0) return twoSubtasks(body, 0);
      if (i === 1) return twoSubtasks(body, 1);
      const names = (body.tools as { function: { name: string } }[]).map(
        (t) => t.function.name,
      );
      if (i <= 4) expect(names).toEqual(["return_result"]);
      else expect(names).toEqual(["finish_analysis"]);
      if (i === 2)
        return reply([call("execute_python", { code: "FORBIDDEN" })]);
      if (i === 3) return reply([returned(body, ["cell-999"])]);
      if (i === 4)
        return reply([
          returned(body, ["cell-1"], {
            status: "partial",
            diagnostic: "Unresolved feature hypotheses",
            limitations: ["No candidate fitting performed"],
          }),
        ]);
      if (i === 5) return twoSubtasks(body, 3);
      return reply([finish("cell-1")]);
    },
    async (r, client, runtime) => {
      expect(r.status, r.reason).toBe("completed");
      expect(runtime.state.codes).toEqual(["secret_state=2"]);
      expect(client.bodies).toHaveLength(7);
      expect(client.bodies.every((b) => Number(b.max_tokens) <= 8192)).toBe(
        true,
      );
      const events = await readEvents(r.directory);
      expect(events.filter((e) => e.type === "analysis_closing")).toMatchObject(
        [{ reason: "execution_limit" }],
      );
      const manifest = await readManifest(r.directory);
      expect(manifest.agent).toMatchObject({
        completion_policy: "modeling-diagnostic-v1",
      });
      expect(() => validateConfig(manifest.config)).not.toThrow();
    },
    {},
    [],
    {
      task: {
        ...task,
        organization: "planner-executor",
        completion_policy: "modeling-diagnostic-v1",
        budget: { total_tokens: 400000, executions: 1, action_corrections: 3 },
      },
    },
  );
});

test("diagnostic closure accounts for growing requests and other hard limits", () => {
  const base = {
    role: "executor" as const,
    executorBytes: 80000,
    plannerBytes: 12000,
    modelTimeoutMs: 90000,
    maxRequestBytes: 262144,
    remaining: {
      model_attempts: 10,
      executions: 12,
      tokens: 210000,
      task_ms: 200000,
    },
  };
  expect(diagnosticClosure(base).reason).toBe("token_return_reserve");
  for (const [field, value, reason] of [
    ["model_attempts", 2, "model_attempt_reserve"],
    ["executions", 0, "execution_limit"],
    ["task_ms", 50000, "time_return_reserve"],
  ] as const)
    expect(
      diagnosticClosure({
        ...base,
        remaining: { ...base.remaining, tokens: 400000, [field]: value },
      }).reason,
    ).toBe(reason);
  expect(
    diagnosticClosure({
      ...base,
      maxRequestBytes: 100000,
      remaining: { ...base.remaining, tokens: 400000 },
    }).reason,
  ).toBe("request_growth_reserve");
  expect(() => validateTask({ ...task, completion_policy: "unknown" })).toThrow(
    "completion policy",
  );
  expect(() =>
    validateTask({ ...task, completion_policy: "modeling-diagnostic-v1" }),
  ).toThrow("completion policy");
});

test("diagnostic token reserve returns existing findings before request preflight exhaustion", async () => {
  let closingSeen = false;
  await scenario(
    (body, i) => {
      if (i === 0) return twoSubtasks(body, 0);
      const names = (body.tools as { function: { name: string } }[]).map(
        (t) => t.function.name,
      );
      if (names.length === 1) {
        closingSeen = true;
        return reply([
          names[0] === "return_result"
            ? returned(body, ["cell-1"])
            : finish("cell-1"),
        ]);
      }
      if (i > 8) throw Error("Failed to close");
      return reply([call("execute_python", { code: "print('diagnostic')" })], {
        usage: { prompt_tokens: 50000, completion_tokens: 1000 },
      });
    },
    async (r, client, runtime) => {
      expect(r.status, r.reason).toBe("completed");
      expect(closingSeen).toBe(true);
      expect(runtime.state.codes.length).toBeGreaterThan(0);
      expect(client.bodies.length).toBeLessThan(8);
      const m = await readManifest(r.directory);
      if (m.tokens === "not_applicable") throw Error("Missing token ledger");
      expect(m.tokens.total_tokens).toBeLessThan(200000);
      expect(
        (await readEvents(r.directory)).filter(
          (e) => e.type === "analysis_closing",
        ),
      ).toMatchObject([{ reason: "token_return_reserve" }]);
    },
    {},
    [],
    {
      task: {
        ...task,
        organization: "planner-executor",
        completion_policy: "modeling-diagnostic-v1",
        budget: { total_tokens: 200000, executions: 10 },
      },
    },
  );
});

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

test("failed-cell evidence is corrected within a small shared token budget without extra execution", async () => {
  await scenario(
    (b, i) => {
      if (i === 0)
        return reply([
          call("delegate_analysis", { task: "Check", constraints: [] }),
        ]);
      if (i === 1 || i === 2)
        return reply([
          call("execute_python", {
            code: i === 1 ? "x=1" : "print(x); raise KeyError('age_bucket')",
          }),
        ]);
      if (i === 3) {
        expect(lastFeedback(b).evidence_refs).toEqual(["cell-1"]);
        return reply([returned(b, ["cell-2"])]);
      }
      if (i === 4) {
        const feedback = lastFeedback(b);
        expect(feedback.invalid_evidence_refs).toEqual(["cell-2"]);
        expect(feedback.valid_evidence_refs).toEqual(["cell-1"]);
        expect(obj(feedback.remaining).executions).toBe(0);
        expect(feedback.correction).toContain("unrelated valid IDs");
        return reply([
          returned(b, ["cell-1"], {
            status: "partial",
            diagnostic: "Failed computation omitted; no executions left",
            limitations: ["Only the first computation is supported"],
          }),
        ]);
      }
      return reply([finish("cell-1")]);
    },
    async (r, client, runtime) => {
      expect(r.status).toBe("completed");
      expect(runtime.state.codes).toHaveLength(2);
      expect(client.bodies).toHaveLength(6);
      const events = await readEvents(r.directory);
      const budgets = events.filter((e) => e.type === "agent_budget");
      expect(budgets).toHaveLength(6);
      for (const [i, body] of client.bodies.entries()) {
        expect(Number(body.max_tokens)).toBeGreaterThan(0);
        expect(Number(body.max_tokens)).toBeLessThan(
          profile.generation.max_output_tokens,
        );
        expect(
          Buffer.byteLength(JSON.stringify(body)) +
            Number(body.max_tokens) +
            i * 15,
        ).toBeLessThanOrEqual(50000);
        expect(budgets[i]?.max_output_tokens).toBe(body.max_tokens);
        expect(budgets[i]?.configured_max_output_tokens).toBe(
          profile.generation.max_output_tokens,
        );
      }
      const manifest = await readManifest(r.directory);
      expect(manifest.tokens).toMatchObject({ attempts: 6, total_tokens: 90 });
      expect(manifest.collaboration?.roles.planner.tokens.total_tokens).toBe(
        30,
      );
      expect(manifest.collaboration?.roles.executor.tokens.total_tokens).toBe(
        60,
      );
      expect(manifest.collaboration?.subtasks[0]?.status).toBe("partial");
    },
    { executions: 2, total_tokens: 50000 },
    [{}, { status: "error", partial_state_possible: true }],
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
