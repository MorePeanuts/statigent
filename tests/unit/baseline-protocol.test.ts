import { expect, test } from "bun:test";
import {
  BridgeGate,
  JsonlDecoder,
  requestSchema,
} from "../../src/baselines/protocol";

const request = {
  protocol_version: 1,
  run_id: "run",
  request_id: "one",
  sequence: 1,
  type: "execution.execute",
  code: "print(1)",
};
const response = {
  protocol_version: 1,
  run_id: "run",
  request_id: "one",
  sequence: 1,
  type: "response",
  status: "ok",
  result: { status: "ok" },
};
test("duplicate, concurrent and out of sequence requests never dispatch twice", () => {
  const gate = new BridgeGate("run");
  expect(gate.accept(JSON.stringify(request)).type).toBe("execution.execute");
  gate.settle(response);
  expect(() => gate.accept(JSON.stringify(request))).toThrow();
  expect(() =>
    gate.accept(JSON.stringify({ ...request, request_id: "two", sequence: 2 })),
  ).toThrow();
  const concurrent = new BridgeGate("run");
  concurrent.accept(JSON.stringify(request));
  expect(() =>
    concurrent.accept(
      JSON.stringify({ ...request, request_id: "two", sequence: 2 }),
    ),
  ).toThrow();
  const wrongOrder = new BridgeGate("run");
  expect(() =>
    wrongOrder.accept(JSON.stringify({ ...request, sequence: 2 })),
  ).toThrow();
});
test("late responses, permission fields, identity and terminal are strict", () => {
  for (const invalid of [
    { ...request, type: "shell" },
    { ...request, run_id: "another" },
    { ...request, image: "other" },
  ])
    expect(() =>
      new BridgeGate("run").accept(JSON.stringify(invalid)),
    ).toThrow();
  const gate = new BridgeGate("run");
  gate.accept(JSON.stringify(request));
  gate.close();
  expect(() => gate.settle(response)).toThrow();
  const finish = new BridgeGate("run");
  finish.accept(
    JSON.stringify({
      protocol_version: 1,
      run_id: "run",
      request_id: "one",
      sequence: 1,
      type: "submission.finish",
      submission: { kind: "text", answer: "explicit" },
    }),
  );
  finish.settle(response);
  expect(() =>
    finish.accept(
      JSON.stringify({ ...request, sequence: 2, request_id: "two" }),
    ),
  ).toThrow();
});
test("byte/log limits and split UTF-8 do not lose frame identity", () => {
  const decoder = new JsonlDecoder(20),
    data = Buffer.from('"中文"\n');
  expect(decoder.push(data.subarray(0, 3))).toEqual([]);
  expect(decoder.push(data.subarray(3))).toEqual(['"中文"']);
  decoder.end();
  expect(() => decoder.push(Buffer.alloc(21))).toThrow();
  const partial = new JsonlDecoder();
  partial.push(Buffer.from("{"));
  expect(() => partial.end()).toThrow();
  const limits = {
    request_bytes: 1000,
    response_bytes: 1000,
    log_bytes: 170,
    stderr_bytes: 10,
  };
  const gate = new BridgeGate("run", limits);
  gate.accept(JSON.stringify(request));
  expect(() => gate.settle(response)).toThrow();
});
test("history preserves supplier reasoning and rejects remote image/path overrides", () => {
  const msg = {
    role: "assistant",
    content: null,
    reasoning_content: "reasoning",
    tool_calls: [
      {
        id: "tool1",
        type: "function",
        function: { name: "execute", arguments: "{}" },
      },
    ],
  };
  expect(
    requestSchema.parse({
      protocol_version: 1,
      run_id: "run",
      request_id: "one",
      sequence: 1,
      type: "model.request",
      stage: "planning",
      messages: [msg],
    }),
  ).toHaveProperty("messages", [msg]);
  expect(() =>
    requestSchema.parse({
      ...request,
      type: "artifact.read",
      code: undefined,
      path: "../other",
    }),
  ).toThrow();
});
