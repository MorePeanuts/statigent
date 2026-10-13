import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptSession } from "../../src/execution/script-session";
import { exportNotebooks } from "../../src/records/notebook";
import { buildScripts } from "../../src/records/script-journal";
import { RunRecorder, readEvents, readManifest } from "../../src/records/store";
import { FakeScriptTransport, scriptConfig } from "../helpers/script";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "script-records-"));
  const config = scriptConfig();
  const recorder = await RunRecorder.create({
    runRoot: root,
    config: { ...config },
    runId: config.run_id,
    inputs: [],
    image: { id: "test", platform: "linux/arm64" },
    seed: 42,
  });
  const session = await ScriptSession.create(
    config,
    recorder,
    new FakeScriptTransport(),
  );
  return { root, recorder, session };
}
test("v4 script record aggregates stages once and exports immutable source", async () => {
  const { recorder, session } = await fixture();
  await session.execute("print(42)");
  await session.execute("print(43)");
  await session.close();
  await recorder.finish("completed");
  const exported = await exportNotebooks(recorder.directory);
  const first = await readFile(
    join(recorder.directory, exported.paths[0] ?? ""),
    "utf8",
  );
  expect(first).toBe("print(42)");
  const again = await exportNotebooks(recorder.directory);
  expect(again.paths[0]).not.toBe(exported.paths[0]);
  expect(
    await readFile(join(recorder.directory, exported.paths[0] ?? ""), "utf8"),
  ).toBe(first);
  const m = await readManifest(recorder.directory);
  expect(m.timing.execution_count).toBe(2);
  expect(m.timing.execution_ms).toBe(10);
  expect(m.timing.script_stages).toEqual({
    process_startup_ms: 2,
    execution_ms: 4,
    collection_ms: 2,
    cleanup_ms: 2,
    unknown_stages: 0,
  });
  expect(m.export.notebook_status).toBe("not_applicable");
  expect(m.replay.eligible).toBe(true);
});
test("script journal rejects mismatched backend, identity, source and missing facts", async () => {
  const { recorder, session } = await fixture();
  await session.execute("print(42)");
  await session.close();
  const events = await readEvents(recorder.directory);
  for (const change of [
    (x: Record<string, unknown>[]) => {
      const e = x.find((e) => e.type === "dispatch");
      if (e) e.backend = "persistent-kernel";
    },
    (x: Record<string, unknown>[]) => {
      const e = x.find((e) => e.type === "dispatch");
      if (e) e.code_sha256 = "bad";
    },
    (x: Record<string, unknown>[]) => {
      const r = x.find((e) => e.type === "finish")?.result as Record<
        string,
        unknown
      >;
      r.execution_id = "wrong";
    },
    (x: Record<string, unknown>[]) => {
      const r = x.find((e) => e.type === "finish")?.result as Record<
        string,
        unknown
      >;
      delete r.process;
    },
    (x: Record<string, unknown>[]) => {
      const r = x.find((e) => e.type === "finish")?.result as Record<
        string,
        unknown
      >;
      r.protocol_version = 3;
    },
  ]) {
    const copy = structuredClone(events);
    change(copy);
    expect(() => buildScripts(copy)).toThrow();
  }
  for (const change of [
    { schema_version: 99 },
    { execution: undefined },
    {
      execution: { ...recorder.manifest.execution, initialization: "unknown" },
    },
    {
      execution: {
        ...recorder.manifest.execution,
        backend: "persistent-kernel",
      },
    },
  ]) {
    await writeFile(
      join(recorder.directory, "manifest.json"),
      JSON.stringify({ ...recorder.manifest, ...change }),
    );
    await expect(readManifest(recorder.directory)).rejects.toThrow();
  }
});

test("script trajectory uses execution identities, preserves failures and scrubs paths", async () => {
  const { recorder, session } = await fixture();
  await session.execute("print('/private/host/secret')");
  await session.close();
  await recorder.finish("completed");
  const { buildTrajectory } = await import(
    "../../src/evaluation/agents/trajectory"
  );
  const trajectory = await buildTrajectory(recorder.directory, "report", [
    "/private/host",
  ]);
  expect(trajectory).toContain("Backend: fresh-script");
  expect(trajectory).toContain("(execution ");
  expect(trajectory).not.toContain("kernel");
  expect(trajectory).toContain("[host]/secret");
  expect((trajectory.match(/## Step/g) ?? []).length).toBe(1);
});
