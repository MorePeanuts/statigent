import { describe, expect, test } from "bun:test";
import models from "../../configs/models.json";
import task from "../../configs/tasks/synthetic-eda.json";
import { validateTask } from "../../src/agent/config";
import {
  ChatClient,
  ModelFailure,
  normalizeUsage,
} from "../../src/models/client";
import {
  resolveCredential,
  selectProfile,
  validateProfile,
} from "../../src/models/config";

const profile = validateProfile(models[0]);
const response = (extra = {}) => ({
  id: "server-1",
  model: "returned-version",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "reasoning",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "execute_python",
              arguments: '{"code":"print(1)"}',
            },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_cache_hit_tokens: 8,
    prompt_cache_miss_tokens: 4,
    completion_tokens_details: { reasoning_tokens: 2 },
  },
  ...extra,
});
const limits = {
  timeout_ms: 1000,
  max_request_bytes: 10000,
  max_response_bytes: 10000,
};
async function service(
  handler: (req: Request) => Response | Promise<Response>,
  run: (client: ChatClient) => Promise<void>,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new ChatClient(
    validateProfile({
      ...profile,
      base_url: server.url.href,
      allow_loopback_http: true,
    }),
    { DEEPSEEK_API_KEY: "fake-secret-TEST" },
  );
  try {
    await run(client);
  } finally {
    await server.stop(true);
  }
}
describe("configuration", () => {
  test("examples, strict fields and priority selection", () => {
    expect(validateTask(task).budget.model_attempts).toBe(12);
    const generic = {
      ...profile,
      id: "other",
      model: "custom-model",
      provider: "generic",
      capabilities: { tool_calls: true, thinking: false },
      generation: { max_output_tokens: 42 },
    };
    expect(selectProfile([profile, generic], "other").model).toBe(
      "custom-model",
    );
    for (const patch of [
      { protocol: "unknown" },
      { model: "" },
      { headers: {} },
      { capabilities: { tool_calls: false, thinking: true } },
      { generation: { ...profile.generation, temperature: 1 } },
      { base_url: "https://user:password@example.com" },
      { base_url: "http://example.com", allow_loopback_http: true },
    ])
      expect(() => validateProfile({ ...profile, ...patch })).toThrow();
    for (const patch of [
      { goal: " " },
      { budget: { model_attempts: 0 } },
      { budget: { thing: 1 } },
      { execution: { ...task.execution, inputs: ["../secret"] } },
    ])
      expect(() => validateTask({ ...task, ...patch })).toThrow();
    expect(() => resolveCredential(profile, {})).toThrow("DEEPSEEK_API_KEY");
  });
});
test("multi-turn reasoning and generic parameters, safe snapshots", async () => {
  const bodies: Record<string, unknown>[] = [];
  await service(
    async (req) => {
      expect(req.headers.get("authorization")).toBe("Bearer fake-secret-TEST");
      bodies.push((await req.json()) as Record<string, unknown>);
      return Response.json(response());
    },
    async (client) => {
      const first = await client.send(
        client.requestBody([{ role: "user", content: "task" }], []),
        limits,
        new AbortController().signal,
      );
      expect(first.model).toBe("returned-version");
      expect(first.usage.total_tokens).toBe(16);
      await client.send(
        client.requestBody(
          [
            first.message,
            { role: "tool", tool_call_id: "call-1", content: "ok" },
          ],
          [],
        ),
        limits,
        new AbortController().signal,
      );
      expect(JSON.stringify(bodies)).not.toContain("fake-secret");
      expect(JSON.stringify(bodies[1])).toContain("reasoning_content");
      expect(bodies[0]?.model).toBe("deepseek-flash");
      const generic = new ChatClient(
        validateProfile({
          ...client.profile,
          provider: "generic",
          capabilities: { tool_calls: true, thinking: false },
          generation: { max_output_tokens: 20, temperature: 0 },
        }),
        { DEEPSEEK_API_KEY: "fake-secret-TEST" },
      );
      expect(generic.requestBody([], [])).not.toContain("thinking");
    },
  );
});
test("usage subsets and unknown never invented", () => {
  expect(normalizeUsage(response().usage).total_tokens).toBe(16);
  expect(normalizeUsage(null).total_tokens).toBeNull();
  expect(normalizeUsage({ prompt_tokens: 4 }).status).toBe("unknown");
  expect(() =>
    normalizeUsage({ prompt_tokens: 1, prompt_cache_hit_tokens: 2 }),
  ).toThrow();
});
test("HTTP errors, redirect, oversized, invalid and truncated protocols", async () => {
  for (const status of [401, 403, 429, 500, 302])
    await service(
      () =>
        new Response("fake-secret-TEST", {
          status,
          headers: { Location: "http://127.0.0.1:1/leak" },
        }),
      async (client) => {
        try {
          await client.send("{}", limits, new AbortController().signal);
          throw new Error("expected failure");
        } catch (error) {
          expect(error).toBeInstanceOf(ModelFailure);
          expect(String(error)).not.toContain("fake-secret");
          expect((error as ModelFailure).retryable).toBe(status === 429);
        }
      },
    );
  await service(
    () => new Response("x".repeat(10001)),
    async (client) => {
      await expect(
        client.send("{}", limits, new AbortController().signal),
      ).rejects.toThrow("response_size_limit");
    },
  );
  await service(
    () => new Response("not-json"),
    async (client) => {
      await expect(
        client.send("{}", limits, new AbortController().signal),
      ).rejects.toThrow("invalid_response_json");
    },
  );
  await service(
    () => Response.json(response({ choices: [] })),
    async (client) => {
      await expect(
        client.send("{}", limits, new AbortController().signal),
      ).rejects.toThrow("invalid_response_protocol");
    },
  );
});
test("timeouts and pre-send limits do not accept late responses", async () => {
  let requests = 0;
  await service(
    async () => {
      requests++;
      await Bun.sleep(60);
      return Response.json(response());
    },
    async (client) => {
      await expect(
        client.send("x".repeat(10001), limits, new AbortController().signal),
      ).rejects.toThrow("request_size_limit");
      const abort = new AbortController();
      abort.abort();
      await expect(client.send("{}", limits, abort.signal)).rejects.toThrow(
        "cancelled_before_send",
      );
      expect(requests).toBe(0);
      await expect(
        client.send(
          "{}",
          { ...limits, timeout_ms: 10 },
          new AbortController().signal,
        ),
      ).rejects.toThrow("request_aborted");
      expect(requests).toBe(1);
    },
  );
});

test("no-tool assistant reasoning is retained and tool schemas sent unchanged", async () => {
  let index = 0;
  const tools = [
    {
      type: "function",
      function: { name: "execute_python", parameters: { type: "object" } },
    },
  ];
  await service(
    async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body.tools).toEqual(tools);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.max_tokens).toBe(4096);
      if (index++ === 0)
        return Response.json(
          response({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "consider",
                  reasoning_content: "first reasoning",
                },
              },
            ],
          }),
        );
      expect(JSON.stringify(body.messages)).toContain("first reasoning");
      return Response.json(response());
    },
    async (client) => {
      const first = await client.send(
        client.requestBody([], tools),
        limits,
        new AbortController().signal,
      );
      await client.send(
        client.requestBody(
          [first.message, { role: "user", content: "continue" }],
          tools,
        ),
        limits,
        new AbortController().signal,
      );
    },
  );
});
