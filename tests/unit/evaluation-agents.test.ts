import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandOptions,
  parseCommandResponse,
} from "../../src/evaluation/agents/container-command";
import { statigentAdapter } from "../../src/evaluation/agents/statigent";
import {
  emptyUsage,
  type Invocation,
  validateInvocation,
} from "../../src/evaluation/contracts";
import { exportNotebooks } from "../../src/records/notebook";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { submission, task } from "../helpers/evaluation";
export function invocation(root: string): Invocation {
  return {
    schema_version: 1,
    evaluation_id: "eval-test",
    unit_id: "unit-000001",
    task,
    config: {
      id: "eda",
      adapter: "statigent-eda",
      options: { image: "statigent-runtime:dev" },
      model: profile,
      require_seed: true,
    },
    budget: { timeout_ms: 10000, model_attempts: 3, total_tokens: 100000 },
    seed: 42,
    input_root: root,
    run_root: join(root, "runs"),
  };
}
test("invocation and command protocol reject unsupported configuration and forged outputs", () => {
  expect(() =>
    validateInvocation({ ...invocation("/tmp"), schema_version: 2 }),
  ).toThrow();
  for (const extra of [
    { network: true },
    { env: { API_KEY: "key" } },
    { shell: "sh" },
  ])
    expect(() =>
      commandOptions({ image: "test", argv: ["uv"], ...extra }),
    ).toThrow();
  expect(
    parseCommandResponse(JSON.stringify(submission()), "unit-000001")
      .native_run,
  ).toBeNull();
  for (const out of [
    "{}\n{}",
    "oops",
    JSON.stringify({
      ...submission(),
      native_run: { id: "foreign", directory: "/etc" },
    }),
    JSON.stringify({ ...submission(), usage: emptyUsage("unknown") }),
  ])
    expect(() => parseCommandResponse(out, "unit-000001")).toThrow();
});
test("Statigent preserves exact final summary, native run and measured retry-inclusive usage", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eda-adapter-")));
  try {
    await writeFile(join(root, "data.csv"), "value\n1\n2\n");
    const runtime = fakeRuntime();
    const client = new ScriptClient((body, n) => {
      if (n === 0) return reply([call("execute_python", { code: "print(3)" })]);
      const action = finish(String(lastFeedback(body).cell_id));
      const args = JSON.parse(action.function.arguments);
      args.summary = "@sum[3]";
      action.function.arguments = JSON.stringify(args);
      return reply([action]);
    });
    const adapter = statigentAdapter({
      overrides: {
        client,
        createSession: runtime.createSession,
        export: (dir, _, status) =>
          exportNotebooks(dir, async () => {}, status),
      },
    });
    const result = await adapter.run(invocation(root));
    expect(result.status).toBe("completed");
    expect(result.answer_text).toBe("@sum[3]");
    expect(result.native_run?.id).toBeDefined();
    expect(result.usage).toMatchObject({
      source: "measured",
      attempts: 2,
      total_tokens: 30,
      unknown_attempts: 0,
    });
    expect(client.bodies[0]).not.toHaveProperty("labels");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("early failures propagate and unavailable ledgers retain unknown costs", async () => {
  const early = statigentAdapter({
    run: async () => {
      throw new Error("before run");
    },
  });
  await expect(early.run(invocation("/tmp"))).rejects.toThrow("before run");
  const missing = statigentAdapter({
    run: async () => ({
      run_id: "native",
      directory: "/tmp/missing-statigent-run",
      status: "failed",
      reason: "cleanup_failed",
      analysis: null,
      record_error: false,
    }),
  });
  const s = await missing.run(invocation("/tmp"));
  expect(s.usage.source).toBe("unknown");
  expect(s.record_error).toBe(true);
  expect(s.cleanup_error).not.toBeNull();
});
