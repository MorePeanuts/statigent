import { expect, test } from "bun:test";
import { validateTask } from "../../src/agent/config";
import { validateBackend } from "../../src/execution/backend";
import {
  DEFAULT_LIMITS,
  parseBridgeMessage,
  validateConfig,
} from "../../src/execution/protocol";
import {
  parseScriptMessage,
  SCRIPT_INITIALIZATION,
} from "../../src/execution/script-protocol";

const execution = { image: "fixture", input_root: ".", inputs: [], seed: 42 };
const base = {
  protocol_version: 2,
  backend: "fresh-script",
  request_id: "r1",
  session_id: "s1",
};
const result = {
  ...base,
  type: "result",
  execution_id: "e1",
  execution_seq: 1,
  status: "ok",
  started: true,
  process: { instance_id: "p1", pid: 12 },
  session_available: true,
  persistence_complete: true,
  elapsed_ms: 10,
  timing: {
    process_startup_ms: 2,
    execution_ms: 3,
    collection_ms: 3,
    cleanup_ms: 2,
  },
};
const parse = (value: unknown) =>
  parseScriptMessage(JSON.stringify(value), 10000, "s1");

test("backend selection defaults to persistent and rejects unsupported configurations", () => {
  expect(validateBackend(undefined)).toBe("persistent-kernel");
  const task = { goal: "analyze", model_profile: "fixture", execution };
  expect(validateTask(task).backend).toBe("persistent-kernel");
  expect(
    validateTask({ ...task, backend: "fresh-script" }).execution.backend,
  ).toBe("fresh-script");
  for (const backend of [null, "script", 2, {}, true]) {
    expect(() => validateTask({ ...task, backend })).toThrow();
    expect(() =>
      validateConfig({
        ...execution,
        run_id: "r",
        staging_root: ".",
        limits: DEFAULT_LIMITS,
        backend,
      }),
    ).toThrow();
  }
  const old = {
    ...execution,
    run_id: "r",
    staging_root: ".",
    limits: DEFAULT_LIMITS,
  };
  expect(validateConfig(old)).toEqual(old);
});

test("v2 script results carry process facts without synthetic kernel state", () => {
  expect<unknown>(parse(result)).toEqual(result);
  expect(
    parse({
      ...base,
      type: "ready",
      initialization: SCRIPT_INITIALIZATION,
      session_available: true,
      dependencies: { python: "3.12.9" },
    }).type,
  ).toBe("ready");
  const unstarted = {
    ...result,
    status: "error",
    started: false,
    process: null,
    timing: {
      process_startup_ms: null,
      execution_ms: null,
      collection_ms: 0,
      cleanup_ms: 0,
    },
  };
  expect<unknown>(parse(unstarted)).toEqual(unstarted);
  for (const patch of [
    { protocol_version: 1 },
    { protocol_version: 3 },
    { backend: "persistent-kernel" },
    { session_id: "other" },
    { execution_id: undefined },
    { execution_seq: 0 },
    { session_available: "true" },
    { started: "true" },
    { process: null },
    { process: { pid: 10 } },
    { process: { instance_id: "p", pid: -1 } },
    { status: "kernel_lost" },
    { elapsed_ms: -1 },
    { timing: {} },
    { kernel_epoch: 1 },
    { session_available: false },
    { persistence_complete: false },
  ])
    expect(() => parse({ ...result, ...patch })).toThrow();
});

test("v1 remains strict and v2 output/artifact frames are validated", () => {
  const v1 = {
    protocol_version: 1,
    request_id: "r1",
    session_id: "s1",
    type: "ready",
    kernel_epoch: 1,
    kernel_available: true,
    dependencies: {},
  };
  expect<unknown>(parseBridgeMessage(JSON.stringify(v1), 10000, "s1")).toEqual(
    v1,
  );
  expect(() => parse(v1)).toThrow();
  expect(() =>
    parseBridgeMessage(JSON.stringify(result), 10000, "s1"),
  ).toThrow();
  const output = {
    ...base,
    type: "output",
    execution_id: "e1",
    execution_seq: 1,
    output: { output_type: "stream", name: "stdout", text: "hello" },
  };
  expect(parse(output).type).toBe("output");
  expect(() =>
    parse({ ...output, output: { output_type: "clear_output", wait: true } }),
  ).toThrow();
  const artifact = {
    ...base,
    type: "artifact",
    path: "a.txt",
    mime_type: "text/plain",
    data_base64: "YQ==",
  };
  expect(parse(artifact).type).toBe("artifact");
  expect(() => parse({ ...artifact, execution_id: "e1" })).toThrow();
  expect(() => parse({ ...artifact, data_base64: "!!" })).toThrow();
  expect(() => parseScriptMessage(JSON.stringify(result), 2, "s1")).toThrow();
});
