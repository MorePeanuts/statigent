import { expect, test } from "bun:test";
import { baselineModel } from "../../src/baselines/model";
import { runReAct } from "../../src/baselines/react";
import { reply, ScriptClient } from "../helpers/agent";

function response(content: string) {
  return reply([], {
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content,
          reasoning_content: "retained-reason",
        },
      },
    ],
  });
}
test("ReAct keeps one history, repairs from real feedback and requires explicit finish", async () => {
  const client = new ScriptClient((_body, index) =>
    response(
      JSON.stringify(
        index === 0
          ? { action: "execute", code: "broken()" }
          : index === 1
            ? { action: "execute", code: "print(42)" }
            : { action: "finish", submission: { kind: "text", answer: "42" } },
      ),
    ),
  );
  const model = baselineModel({
    client,
    signal: new AbortController().signal,
    budget: { model_attempts: 4, total_tokens: 50000, timeout_ms: 10000 },
    event: async () => {},
  });
  const requests: string[] = [];
  await runReAct({
    runId: "test",
    task: { goal: "Compute" },
    maxTurns: 4,
    model,
    handle: async (request) => {
      requests.push(request.type);
      return {
        status: requests.length === 1 ? "error" : "ok",
        preview: requests.length === 1 ? "NameError: broken" : "42",
      };
    },
  });
  expect(requests).toEqual([
    "execution.execute",
    "execution.execute",
    "submission.finish",
  ]);
  expect(JSON.stringify(client.bodies[1])).toContain("NameError: broken");
  expect(JSON.stringify(client.bodies[1])).toContain("retained-reason");
  expect(model.usage().attempts).toBe(3);
});
test("ReAct never turns text or execution logs into a final submission", async () => {
  const model = baselineModel({
    client: new ScriptClient(() => response("The answer is 42")),
    signal: new AbortController().signal,
    budget: { model_attempts: 4, total_tokens: 50000, timeout_ms: 10000 },
    event: async () => {},
  });
  let actions = 0;
  await expect(
    runReAct({
      runId: "test",
      task: { goal: "Compute" },
      maxTurns: 2,
      model,
      handle: async () => {
        actions++;
        return {};
      },
    }),
  ).rejects.toThrow("react_turn_limit");
  expect(actions).toBe(0);
});
