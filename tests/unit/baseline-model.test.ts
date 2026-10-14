import { expect, test } from "bun:test";
import { baselineModel } from "../../src/baselines/model";
import { ModelFailure } from "../../src/models/client";
import { profile, reply, ScriptClient } from "../helpers/agent";

function setup(client: ScriptClient, budget = {}) {
  const controller = new AbortController(),
    events: { type: string; details: Record<string, unknown> }[] = [];
  const model = baselineModel({
    client,
    signal: controller.signal,
    budget: {
      model_attempts: 5,
      total_tokens: 50000,
      timeout_ms: 5000,
      ...budget,
    },
    event: async (type, details) => {
      events.push({ type, details });
    },
  });
  return { model, events, controller };
}
test("stages share one account, preserving supplier history and parent retries", async () => {
  const client = new ScriptClient((_body, i) => {
    if (i === 0) throw new ModelFailure("rate_limit", "not_generated", true);
    return reply([]);
  });
  const { model, events } = setup(client);
  const history = [
    {
      role: "assistant" as const,
      content: "previous",
      reasoning_content: "supplier history",
    },
  ];
  await model.request(history, "planning");
  await model.request(history, "debugging");
  expect(model.usage()).toMatchObject({
    attempts: 3,
    total_tokens: 30,
    unknown_attempts: 0,
  });
  expect(events.filter((x) => x.type === "model_request")).toHaveLength(3);
  expect(JSON.stringify(client.bodies)).toContain("supplier history");
  model.close();
  await expect(model.request(history, "late")).rejects.toThrow(
    "model_phase_closed",
  );
  expect(client.bodies).toHaveLength(3);
});
test("unknown accounting never retries even when upstream failure is marked retryable", async () => {
  const client = new ScriptClient(() => {
    throw new ModelFailure("transport_lost", "unknown", true);
  });
  const { model } = setup(client);
  await expect(
    model.request([{ role: "user", content: "task" }], "planning"),
  ).rejects.toThrow("accounting_incomplete");
  await expect(
    model.request([{ role: "user", content: "task" }], "debugging"),
  ).rejects.toThrow("accounting_incomplete");
  expect(model.usage()).toMatchObject({
    source: "unknown",
    attempts: 1,
    unknown_attempts: 1,
  });
  expect(client.bodies).toHaveLength(1);
});
test("truncated responses are accounted but cannot execute", async () => {
  const client = new ScriptClient(() =>
    reply([], {
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: {
            role: "assistant",
            content: "partial code",
            reasoning_content: "partial reasoning",
          },
        },
      ],
    }),
  );
  const { model } = setup(client);
  await expect(
    model.request([{ role: "user", content: "task" }], "code"),
  ).rejects.toThrow("response_length");
  expect(model.usage()).toMatchObject({ attempts: 1, total_tokens: 15 });
});
test("token preflight and cancellation perform no additional calls", async () => {
  const client = new ScriptClient(() => reply([]));
  const { model } = setup(client, { total_tokens: 1 });
  await expect(
    model.request([{ role: "user", content: "task" }], "code"),
  ).rejects.toThrow("token_preflight");
  expect(client.bodies).toHaveLength(0);
  const cancelled = setup(client);
  cancelled.controller.abort();
  await expect(
    cancelled.model.request([{ role: "user", content: "task" }], "code"),
  ).rejects.toThrow("user_cancelled");
  expect(client.bodies).toHaveLength(0);
});
test("actual token threshold preserves measured overage", async () => {
  const client = new ScriptClient(() =>
    reply([], {
      usage: { prompt_tokens: 40000, completion_tokens: 10001 },
    }),
  );
  const { model } = setup(client);
  await expect(
    model.request([{ role: "user", content: "task" }], "code"),
  ).rejects.toThrow("token_threshold");
  expect(model.usage().total_tokens).toBe(50001);
  expect(model.metadata.profile).toEqual(profile);
});
