import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandOptions,
  parseCommandResponse,
} from "../../src/evaluation/agents/container-command";
import { statigentAdapter } from "../../src/evaluation/agents/statigent";
import { emptyUsage, validateInvocation } from "../../src/evaluation/contracts";
import { exportNotebooks } from "../../src/records/notebook";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { invocation, submission } from "../helpers/evaluation";

test("invocation and command protocol reject unsupported configuration and forged outputs", () => {
  expect(() =>
    validateInvocation({ ...invocation("/tmp"), schema_version: 1 }),
  ).toThrow();
  for (const extra of [
    { network: true },
    { env: { API_KEY: "key" } },
    { shell: "sh" },
  ])
    expect(() =>
      commandOptions({ image: "test", argv: ["uv"], ...extra }),
    ).toThrow();
  const response = commandResponse();
  expect(
    parseCommandResponse(JSON.stringify(response), "unit-000001").submission
      .native_run,
  ).toBeNull();
  for (const out of [
    "{}\n{}",
    "oops",
    JSON.stringify({ ...response, schema_version: 2 }),
    JSON.stringify({
      ...response,
      native_run: { id: "foreign", directory: "/etc" },
    }),
    JSON.stringify({ ...response, usage: emptyUsage("unknown") }),
  ])
    expect(() => parseCommandResponse(out, "unit-000001")).toThrow();
});
test("command files are decoded under safe relative names within configured limits", () => {
  const file = (name: string, data: string) => ({
    name,
    base64: Buffer.from(data).toString("base64"),
  });
  const parsed = parseCommandResponse(
    JSON.stringify(
      commandResponse([file("report.md", "# r"), file("img/a.png", "x")]),
    ),
    "unit-000001",
  );
  expect(parsed.files.map((f) => f.path)).toEqual(["report.md", "img/a.png"]);
  expect(parsed.submission.deliverables).toEqual([]);
  for (const name of ["../escape", "/etc/passwd", "a//b", "./a"])
    expect(() =>
      parseCommandResponse(
        JSON.stringify(commandResponse([file(name, "x")])),
        "unit-000001",
      ),
    ).toThrow();
  const limits = { max_file_bytes: 4, max_files_bytes: 6 };
  expect(() =>
    parseCommandResponse(
      JSON.stringify(commandResponse([file("big", "12345")])),
      "unit-000001",
      limits,
    ),
  ).toThrow("max_file_bytes");
  expect(() =>
    parseCommandResponse(
      JSON.stringify(commandResponse([file("a", "1234"), file("b", "123")])),
      "unit-000001",
      limits,
    ),
  ).toThrow("total");
  expect(() =>
    commandOptions({ image: "i", argv: ["x"], max_file_bytes: 2 ** 40 }),
  ).toThrow();
});
function commandResponse(
  artifacts: { name: string; base64: string }[] = [],
): Record<string, unknown> {
  const { deliverables: _d, trajectory: _t, ...rest } = submission();
  return { ...rest, schema_version: 1, artifacts };
}
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
