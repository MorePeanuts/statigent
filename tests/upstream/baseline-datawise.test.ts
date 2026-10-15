import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineModel } from "../../src/baselines/model";
import { runTrustedWorker, workerViewSchema } from "../../src/baselines/worker";
import { reply, ScriptClient } from "../helpers/agent";

export const fstResponses = [
  "```markdown\n[STEP GOAL] Compute an answer.\n```\n```python\nx = 40\n```",
  '```python\nraise ValueError("probe")\n```\n<end_step>',
  "```python\nprint(x + 2)\n```\n<end_debug>",
  "```python\nprint(x + 2)\n```\n<debug_success>",
  '```markdown\nSTATIGENT_FINAL\n{"kind":"text","answer":"42"}\n```\n<Fulfill USER INSTRUCTION>',
];
test("official Datawise FST keeps planning, debug, filtering and host replay", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "datawise-upstream-")),
  );
  const stages: string[] = [],
    codes: string[] = [],
    reasons: string[] = [],
    errors: string[] = [];
  let submission: unknown, notebook: unknown;
  const client = new ScriptClient((_body, index) =>
    reply([], {
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: fstResponses[index] ?? "Unexpected call",
            reasoning_content: `reason-${index}`,
          },
        },
      ],
    }),
  );
  const controller = new AbortController();
  const model = baselineModel({
    client,
    signal: controller.signal,
    budget: { model_attempts: 10, total_tokens: 100000, timeout_ms: 30000 },
    event: async () => {},
  });
  try {
    await runTrustedWorker({
      directory: join(root, "worker"),
      timeout_ms: 30000,
      signal: controller.signal,
      view: workerViewSchema.parse({
        protocol_version: 1,
        run_id: "datawise-probe",
        method: "datawiseagent",
        goal: "Compute 42",
        constraints: [],
        files: [],
        output: { kind: "text", instructions: "Answer explicitly" },
        seed: 7,
        options: {
          schema_version: 1,
          method: "datawiseagent",
          image: "not-used",
        },
      }),
      recorder: {
        event: async (type, details) => {
          if (type === "worker_stderr") errors.push(String(details.text));
        },
      },
      stopExecution: async () => {},
      handle: async (request) => {
        if (request.type === "model.request") {
          stages.push(request.stage);
          return { ...(await model.request(request.messages, request.stage)) };
        }
        if (request.type === "workspace.status")
          return { inputs: [], artifacts: [] };
        if (request.type === "execution.execute") {
          codes.push(request.code);
          return {
            status: request.code.includes("raise") ? "error" : "ok",
            preview: request.code.includes("raise")
              ? "ValueError: probe"
              : "42",
          };
        }
        if (request.type === "execution.restart") {
          reasons.push(request.reason);
          return { kernel_epoch: 2 };
        }
        if (request.type === "notebook.record") {
          notebook = request.notebook;
          return { accepted: true };
        }
        if (request.type === "submission.finish") {
          submission = request.submission;
          return { accepted: true };
        }
        throw new Error("Unexpected request");
      },
    });
    expect(stages).toEqual([
      "initiate",
      "execution",
      "debug",
      "post_filter",
      "planning",
    ]);
    expect(reasons).toEqual(["post-filter"]);
    expect(codes.filter((c) => c.includes("x = 40"))).toHaveLength(2);
    expect(codes.filter((c) => c.includes("print(x + 2)"))).toHaveLength(3);
    expect(submission).toEqual({ kind: "text", answer: "42" });
    expect(notebook).toBeDefined();
    expect(model.usage()).toMatchObject({ attempts: 5, total_tokens: 75 });
    expect(JSON.stringify(client.bodies[1])).toContain("reason-0");
    expect(JSON.stringify(client.bodies[2])).toContain("ValueError: probe");
  } catch (error) {
    throw new Error(`${error}\n${errors.join("").slice(-9000)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

for (const method of ["autogen", "datawiseagent"] as const) {
  test(`${method} rejects truncated model output before executing code`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "baseline-truncated-")),
    );
    let executions = 0;
    const model = baselineModel({
      client: new ScriptClient(() =>
        reply([], {
          choices: [
            {
              index: 0,
              finish_reason: "length",
              message: {
                role: "assistant",
                content: "```python\nprint('must not execute')",
                reasoning_content: "incomplete",
              },
            },
          ],
        }),
      ),
      signal: new AbortController().signal,
      budget: { model_attempts: 2, total_tokens: 50000, timeout_ms: 30000 },
      event: async () => {},
    });
    try {
      await expect(
        runTrustedWorker({
          directory: join(root, "worker"),
          timeout_ms: 30000,
          signal: new AbortController().signal,
          view: workerViewSchema.parse({
            protocol_version: 1,
            run_id: "truncated",
            method,
            goal: "Test truncation",
            constraints: [],
            files: [],
            output: { kind: "text", instructions: "Explicit answer" },
            seed: 7,
            options: { schema_version: 1, method, image: "not-used" },
          }),
          recorder: { event: async () => {} },
          stopExecution: async () => {},
          handle: async (request) => {
            if (request.type === "workspace.status")
              return { inputs: [], artifacts: [] };
            if (request.type === "model.request")
              return {
                ...(await model.request(request.messages, request.stage)),
              };
            if (request.type === "execution.execute") executions++;
            throw new Error("Unexpected request");
          },
        }),
      ).rejects.toThrow();
      expect(executions).toBe(0);
      expect(model.usage()).toMatchObject({ attempts: 1, total_tokens: 15 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
}
