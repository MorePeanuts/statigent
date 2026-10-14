import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineModel } from "../../src/baselines/model";
import { runTrustedWorker, workerViewSchema } from "../../src/baselines/worker";
import { reply, ScriptClient } from "../helpers/agent";

test("official AutoGen assistant/proxy route repair and explicit finish through the host", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "autogen-upstream-")),
  );
  const client = new ScriptClient((_body, index) =>
    reply([], {
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            reasoning_content: `reason-${index}`,
            content:
              index === 0
                ? "```python\nraise ValueError('probe')\n```"
                : index === 1
                  ? "```python\nprint(2)\n```"
                  : 'STATIGENT_FINAL\n{"kind":"text","answer":"2"}',
          },
        },
      ],
    }),
  );
  const controller = new AbortController();
  const model = baselineModel({
    client,
    signal: controller.signal,
    budget: { model_attempts: 5, total_tokens: 50000, timeout_ms: 30000 },
    event: async () => {},
  });
  const codes: string[] = [],
    types: string[] = [];
  let submission: unknown;
  try {
    await runTrustedWorker({
      directory: join(root, "worker"),
      timeout_ms: 30000,
      signal: controller.signal,
      view: workerViewSchema.parse({
        protocol_version: 1,
        run_id: "autogen-probe",
        method: "autogen",
        goal: "Compute two",
        constraints: [],
        files: [],
        output: { kind: "text", instructions: "Explicit answer" },
        seed: 7,
        options: {
          schema_version: 1,
          method: "autogen",
          image: "not-used",
          max_turns: 5,
        },
      }),
      recorder: { event: async () => {} },
      stopExecution: async () => {},
      handle: async (request) => {
        types.push(request.type);
        if (request.type === "model.request")
          return { ...(await model.request(request.messages, request.stage)) };
        if (request.type === "execution.execute") {
          codes.push(request.code);
          return {
            status: codes.length === 1 ? "error" : "ok",
            preview: codes.length === 1 ? "ValueError: probe" : "2",
          };
        }
        if (request.type === "submission.finish") {
          submission = request.submission;
          return { accepted: true };
        }
        throw new Error("Unexpected request");
      },
    });
    expect(types).toEqual([
      "model.request",
      "execution.execute",
      "model.request",
      "execution.execute",
      "model.request",
      "submission.finish",
    ]);
    expect(codes).toEqual(["raise ValueError('probe')", "print(2)"]);
    expect(submission).toEqual({ kind: "text", answer: "2" });
    expect(model.usage()).toMatchObject({ attempts: 3, total_tokens: 45 });
    expect(JSON.stringify(client.bodies[1])).toContain("reason-0");
    expect(JSON.stringify(client.bodies[1])).toContain("ValueError: probe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
