import { expect, test } from "bun:test";
import models from "../../configs/models.json";
import { validateConfig } from "../../src/evaluation/plan";
import {
  ChatClient,
  completeText,
  type Message,
  ModelFailure,
} from "../../src/models/client";
import { selectProfile, validateProfile } from "../../src/models/config";
import { checkImages, imageInfo } from "../../src/models/images";
import { gif, jpeg, png, webp } from "../helpers/images";

const agent = selectProfile(models, "deepseek-flash");
const judge = selectProfile(models, "deepseek-flash-judge");
const limits = {
  timeout_ms: 1000,
  max_request_bytes: 1 << 20,
  max_response_bytes: 1 << 16,
};
const env = { DEEPSEEK_API_KEY: "fake-secret-TEST" };
function reply(extra: Record<string, unknown> = {}, message = {}) {
  return {
    id: "r1",
    model: "deepseek-flash",
    system_fingerprint: "fp-1",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "verdict", ...message },
        ...extra,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}
async function service(
  profile: typeof judge,
  handler: (body: Record<string, unknown>) => Response,
  run: (client: ChatClient, bodies: Record<string, unknown>[]) => Promise<void>,
) {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      return handler(body);
    },
  });
  try {
    await run(
      new ChatClient(
        validateProfile({
          ...profile,
          base_url: server.url.href,
          allow_loopback_http: true,
        }),
        env,
      ),
      bodies,
    );
  } finally {
    await server.stop(true);
  }
}
test("profiles without vision stay valid; the judge profile is explicit and non-thinking", () => {
  expect(agent.capabilities.vision).toBe(false);
  expect(agent.generation.max_output_tokens).toBe(65536);
  expect(judge).toMatchObject({
    model: "deepseek-flash",
    capabilities: { vision: true },
    generation: {
      thinking: "disabled",
      temperature: 0,
      max_output_tokens: 16384,
    },
  });
  for (const vision of ["yes", 1, null])
    expect(() =>
      validateProfile({
        ...models[1],
        capabilities: { tool_calls: true, thinking: true, vision },
      }),
    ).toThrow();
  expect(() =>
    validateProfile({
      ...models[1],
      generation: { thinking: "enabled", temperature: 0, max_output_tokens: 1 },
    }),
  ).toThrow("temperature");
});
test("the agent request carries the raised output limit", async () => {
  await service(
    agent,
    () => Response.json(reply({}, { reasoning_content: "r" })),
    async (client, bodies) => {
      await client.send(
        client.requestBody(
          [{ role: "user", content: "x" }],
          [{ type: "function" }],
        ),
        limits,
        new AbortController().signal,
      );
      expect(bodies[0]).toMatchObject({
        max_tokens: 65536,
        thinking: { type: "enabled" },
        tool_choice: "auto",
      });
    },
  );
});
test("image detection uses content and enforces size, count and per-side limits", () => {
  expect(imageInfo(png(10, 20))).toMatchObject({
    format: "png",
    width: 10,
    height: 20,
  });
  expect(imageInfo(jpeg(30, 40))).toMatchObject({
    format: "jpeg",
    width: 30,
    height: 40,
  });
  expect(imageInfo(gif(5, 6))).toMatchObject({
    format: "gif",
    width: 5,
    height: 6,
  });
  expect(imageInfo(webp(7, 8))).toMatchObject({
    format: "webp",
    width: 7,
    height: 8,
  });
  expect(imageInfo(Buffer.from("<svg/>"))).toBeNull();
  const small = {
    max_image_bytes: 100,
    max_images: 20,
    max_side: 8192,
    many_images: 15,
    max_side_many: 4096,
  };
  expect(() => checkImages([Buffer.alloc(101)], small)).toThrow("size");
  expect(() => checkImages([Buffer.from("not an image")], small)).toThrow(
    "format",
  );
  expect(() => checkImages([png(8193, 1)], small)).toThrow("dimension");
  expect(checkImages(Array(14).fill(png(5000, 10)), small)).toHaveLength(14);
  expect(() => checkImages(Array(15).fill(png(5000, 10)), small)).toThrow(
    "dimension",
  );
  expect(() => checkImages(Array(21).fill(png(1, 1)), small)).toThrow("count");
});
test("image parts serialize as data URLs only for vision profiles and only in user messages", async () => {
  const content: Message = {
    role: "user",
    content: [
      { type: "text", text: "compare" },
      { type: "image", data: png(2, 2) },
      { type: "image", data: jpeg(3, 3) },
    ],
  };
  const vision = new ChatClient(judge, env);
  const body = JSON.parse(vision.requestBody([content], []));
  expect(body.tools).toBeUndefined();
  expect(body.tool_choice).toBeUndefined();
  expect(body.messages[0].content).toEqual([
    { type: "text", text: "compare" },
    {
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${png(2, 2).toString("base64")}`,
      },
    },
    {
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${jpeg(3, 3).toString("base64")}`,
      },
    },
  ]);
  expect(() => new ChatClient(agent, env).requestBody([content], [])).toThrow(
    "vision_capability_required",
  );
  expect(() =>
    vision.requestBody(
      [
        {
          role: "system",
          content: [{ type: "image", data: png(1, 1) }],
        } as never,
      ],
      [],
    ),
  ).toThrow("only_in_user");
  expect(() =>
    vision.requestBody(
      [{ role: "user", content: [{ type: "image", data: Buffer.from("x") }] }],
      [],
    ),
  ).toThrow("format");
  // A remote URL has no image bytes, so it cannot be smuggled through as an image part.
  expect(() =>
    vision.requestBody(
      [
        {
          role: "user",
          content: [
            { type: "image", data: Buffer.from("https://example.com/a.png") },
          ],
        },
      ],
      [],
    ),
  ).toThrow("format");
});
test("completeText returns text and rejects truncation, tool calls and empty output", async () => {
  const outcomes: Record<string, unknown>[] = [
    reply(),
    reply({ finish_reason: "length" }),
    reply(
      { finish_reason: "tool_calls" },
      {
        content: null,
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: { name: "x", arguments: "{}" },
          },
        ],
      },
    ),
    reply({}, { content: "  " }),
  ];
  let n = 0;
  await service(
    judge,
    () => Response.json(outcomes[n++]),
    async (client, bodies) => {
      const ok = await completeText(
        client,
        [{ role: "user", content: "judge" }],
        limits,
        new AbortController().signal,
      );
      expect(ok).toMatchObject({ text: "verdict", system_fingerprint: "fp-1" });
      expect(bodies[0]).not.toHaveProperty("tools");
      expect(bodies[0]).toMatchObject({ max_tokens: 16384, temperature: 0 });
      for (const code of [
        "truncated",
        "unexpected_tool_calls",
        "empty_content",
      ]) {
        const error = await completeText(
          client,
          [{ role: "user", content: "judge" }],
          limits,
          new AbortController().signal,
        ).catch((e) => e);
        expect(error).toBeInstanceOf(ModelFailure);
        expect(error).toMatchObject({ code, accounting: "known" });
        expect(error.usage.total_tokens).toBe(12);
      }
    },
  );
});
test("rate limits are retryable failures and timeouts never accept late output", async () => {
  await service(
    judge,
    () => Response.json({ error: "slow down" }, { status: 429 }),
    async (client) => {
      const error = await completeText(
        client,
        [{ role: "user", content: "x" }],
        limits,
        new AbortController().signal,
      ).catch((e) => e);
      expect(error).toMatchObject({ code: "rate_limited", retryable: true });
    },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      await Bun.sleep(300);
      return Response.json(reply());
    },
  });
  try {
    const client = new ChatClient(
      validateProfile({
        ...judge,
        base_url: server.url.href,
        allow_loopback_http: true,
      }),
      env,
    );
    const error = await completeText(
      client,
      [{ role: "user", content: "x" }],
      { ...limits, timeout_ms: 50 },
      new AbortController().signal,
    ).catch((e) => e);
    expect(error).toMatchObject({ accounting: "unknown" });
    const oversized = await completeText(
      client,
      [{ role: "user", content: "x".repeat(2048) }],
      { ...limits, max_request_bytes: 1024 },
      new AbortController().signal,
    ).catch((e) => e);
    expect(oversized).toMatchObject({
      code: "request_size_limit",
      accounting: "not_generated",
    });
  } finally {
    await server.stop(true);
  }
});
test("evaluation config snapshots record the raised agent output limit", async () => {
  const smoke = await Bun.file(
    "configs/evaluations/infiagent-smoke.json",
  ).json();
  const config = validateConfig(smoke, null, models);
  expect(config.agents[0]?.model?.generation.max_output_tokens).toBe(65536);
  // The agent reserves the full output limit before each request (see docs/agent.md).
  expect(config.task_budget.total_tokens).toBeGreaterThan(65536);
});
test("documented judge profile example matches the shipped configuration", async () => {
  const doc = await Bun.file("docs/agent.md").text();
  const block = /```json\n([\s\S]*?)```/.exec(
    doc.slice(doc.indexOf("评分使用的评委 profile 示例")),
  )?.[1];
  if (!block) throw new Error("Missing documented judge profile");
  expect(validateProfile(JSON.parse(block))).toEqual(judge);
});
