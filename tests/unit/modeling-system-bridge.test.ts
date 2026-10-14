import { expect, test } from "bun:test";
import {
  DETERMINISTIC_PROFILE,
  DeterministicModelingClient,
} from "../../src/modeling/deterministic";
import { systemBridge } from "../../src/modeling/system-bridge";

test("system bridge rejects invalid identity, unknown operations and mixed phase fields", async () => {
  const base = {
    version: 1,
    request_id: "example",
    run_root: "runs/system-invalid",
  };
  for (const request of [
    { ...base, version: 2, operation: "fit" },
    { ...base, request_id: "../escape", operation: "fit" },
    { ...base, operation: "execute" },
    { ...base, operation: "fit", frozen_root: "other" },
    { ...base, operation: "predict", task: {} },
    {
      ...base,
      operation: "predict",
      features: { path: "x", bytes: 0, sha256: "bad" },
    },
  ])
    await expect(
      systemBridge(request, new AbortController().signal),
    ).rejects.toThrow();
});
test("deterministic controller emits one fit and a finish with no network or token usage", async () => {
  const client = new DeterministicModelingClient(
    "def build_pipeline(seed): pass",
  );
  const signal = new AbortController().signal;
  const limits = {
    timeout_ms: 100,
    max_request_bytes: 10000,
    max_response_bytes: 10000,
  };
  expect(client.profile).toEqual(DETERMINISTIC_PROFILE);
  const first = await client.send("{}", limits, signal),
    last = await client.send("{}", limits, signal);
  expect(first.message.tool_calls?.[0]?.function.name).toBe("run_experiment");
  expect(last.message.tool_calls?.[0]?.function.name).toBe("finish_modeling");
  expect(first.usage.total_tokens).toBe(0);
  expect(last.usage.total_tokens).toBe(0);
  await expect(client.send("{}", limits, signal)).rejects.toThrow(
    "exactly two",
  );
});
