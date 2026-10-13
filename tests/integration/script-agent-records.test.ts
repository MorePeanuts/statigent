import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgent } from "../../src/agent/run";
import { checkScriptSmoke } from "../../src/agent/script-smoke";
import { replayRun } from "../../src/records/replay";
import { readEvents, readManifest, sha256 } from "../../src/records/store";
import { profile, ScriptClient, task } from "../helpers/agent";
import { freshAgentScript } from "../helpers/fresh-agent";

async function hashes(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (file.isFile()) {
      const p = join(file.parentPath, file.name);
      files[p] = sha256(await readFile(p));
    }
  }
  return files;
}
for (const organization of ["single", "planner-executor"] as const)
  test(`fresh ${organization} report, process facts, immutable snapshots and independent replay`, async () => {
    const root = await mkdtemp(resolve("runs/script-agent-"));
    const result = await runAgent({
      task: {
        ...task,
        organization,
        backend: "fresh-script",
        report: {
          image_types: ["png"],
          max_images: 4,
          max_image_bytes: 524288,
          max_report_bytes: 10000,
        },
        execution: {
          ...task.execution,
          image:
            process.env.STATIGENT_TEST_IMAGE ??
            "statigent-runtime:fresh-script",
        },
      },
      profile,
      runRoot: root,
      client: new ScriptClient(freshAgentScript(organization)),
    });
    expect(result.status).toBe("completed");
    expect((await checkScriptSmoke(result)).status).toBe("passed");
    const manifest = await readManifest(result.directory);
    expect(manifest.schema_version).toBe(4);
    expect(manifest.export.kind).toBe("scripts");
    expect(manifest.export.notebook_status).toBe("not_applicable");
    expect(manifest.timing.execution_count).toBe(2);
    expect(manifest.timing.script_stages?.process_startup_ms).toBeGreaterThan(
      0,
    );
    expect(manifest.workspace_collection.status).toBe("complete");
    const events = await readEvents(result.directory);
    const results = events
      .filter((e) => e.type === "finish")
      .map((e) => e.result as Record<string, unknown>);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => JSON.stringify(r.process))).size).toBe(2);
    expect(JSON.stringify(results)).not.toContain("kernel_epoch");
    expect(result.analysis?.report?.images).toHaveLength(1);
    if (organization === "planner-executor")
      expect(manifest.artifacts.find((a) => a.origin)?.origin?.role).toBe(
        "planner",
      );
    const snapshots = manifest.artifacts.filter(
      (a) => a.source_path === "middle.csv",
    );
    expect(snapshots.length).toBeGreaterThan(1);
    expect(new Set(snapshots.map((a) => a.path)).size).toBe(snapshots.length);
    const before = await hashes(result.directory);
    const replay = await replayRun(result.directory, root);
    expect(replay.status).toBe("passed");
    expect(await hashes(result.directory)).toEqual(before);
    const replayManifest = await readManifest(replay.directory ?? "");
    expect(replayManifest.model).toBe("not_applicable");
    expect(replayManifest.timing.execution_count).toBe(2);
    const source = manifest.export.paths.find((p) => p.endsWith(".py"));
    if (!source) throw Error();
    await writeFile(join(result.directory, source), "print('tamper')");
    const tampered = await replayRun(result.directory, root);
    expect(tampered.status).toBe("failed");
    expect(tampered.reasons.join()).toContain("checksum");
  }, 120000);
test("fresh repaired failures remain exported and strict replay is unsupported", async () => {
  const root = await mkdtemp(resolve("runs/script-repair-"));
  const result = await runAgent({
    task: {
      ...task,
      backend: "fresh-script",
      report: {
        image_types: ["png"],
        max_images: 4,
        max_image_bytes: 524288,
        max_report_bytes: 10000,
      },
      execution: {
        ...task.execution,
        image:
          process.env.STATIGENT_TEST_IMAGE ?? "statigent-runtime:fresh-script",
      },
    },
    profile,
    runRoot: root,
    client: new ScriptClient(freshAgentScript("single", true)),
  });
  expect(result.status).toBe("completed");
  const manifest = await readManifest(result.directory);
  expect(manifest.export.paths.filter((p) => p.endsWith(".py"))).toHaveLength(
    3,
  );
  expect((await replayRun(result.directory, root)).status).toBe("unsupported");
}, 120000);

test("old image capability mismatch prevents the first model request", async () => {
  const client = new ScriptClient(() => {
    throw Error("model must not be called");
  });
  const root = await mkdtemp(resolve("runs/script-old-image-"));
  const result = await runAgent({
    task: {
      ...task,
      backend: "fresh-script",
      execution: { ...task.execution, image: "statigent-runtime:dev" },
    },
    profile,
    client,
    runRoot: root,
  });
  expect(result.status).toBe("failed");
  expect(client.bodies).toHaveLength(0);
}, 120000);

test("legacy image replays through its original persistent entrypoint without modifying source", async () => {
  const { demo } = await import("../../src/cli");
  const { exportNotebooks } = await import("../../src/records/notebook");
  const root = await mkdtemp(resolve("runs/script-legacy-image-"));
  const original = await demo(root, "statigent-runtime:dev");
  const path = join(original.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.schema_version = 2;
  delete manifest.execution;
  await writeFile(path, JSON.stringify(manifest));
  const before = await hashes(original.directory);
  const exported = await exportNotebooks(original.directory);
  expect(exported.directory).not.toBe(original.directory);
  const replay = await replayRun(original.directory, root);
  expect(replay.status).toBe("passed");
  expect(await hashes(original.directory)).toEqual(before);
  expect((await readManifest(replay.directory ?? "")).execution?.backend).toBe(
    "persistent-kernel",
  );
}, 120000);

test("script replay failure never borrows missing files from original artifacts", async () => {
  const { ScriptSession } = await import("../../src/execution/script-session");
  const { FakeScriptTransport } = await import("../helpers/script");
  const { DEFAULT_LIMITS } = await import("../../src/execution/protocol");
  const { RunRecorder } = await import("../../src/records/store");
  const { exportNotebooks } = await import("../../src/records/notebook");
  const { dockerCommand } = await import("../../src/execution/docker");
  const root = await mkdtemp(resolve("runs/script-replay-missing-"));
  const image =
    process.env.STATIGENT_TEST_IMAGE ?? "statigent-runtime:fresh-script";
  const info = JSON.parse(await dockerCommand(["image", "inspect", image]))[0];
  // An intentionally synthetic success record isolates replay's dependency rule.
  // Its artifact exists only in the original record, never in allowed inputs.
  const config = {
    backend: "fresh-script" as const,
    run_id: "synthetic-original",
    image,
    input_root: resolve("tests/fixtures"),
    inputs: [],
    staging_root: join(root, "staging"),
    seed: 42,
    limits: DEFAULT_LIMITS,
  };
  const recorder = await RunRecorder.create({
    runRoot: root,
    runId: config.run_id,
    config: { ...config },
    image: { id: info.Id, platform: `${info.Os}/${info.Architecture}` },
    inputs: [],
    seed: 42,
    environment: { fixture: "synthetic source for replay dependency failure" },
  });
  const session = await ScriptSession.create(
    config,
    recorder,
    new FakeScriptTransport(),
  );
  await session.execute("print(open('original-only.txt').read())");
  await recorder.onArtifact({
    path: "original-only.txt",
    mime_type: "text/plain",
    data_base64: Buffer.from("must not be reused").toString("base64"),
  });
  await session.close();
  recorder.manifest.image = {
    id: info.Id,
    platform: `${info.Os}/${info.Architecture}`,
  };
  await recorder.finish("completed");
  await exportNotebooks(recorder.directory);
  const before = await hashes(recorder.directory);
  const replay = await replayRun(recorder.directory, root);
  expect(replay.status).toBe("failed");
  expect(replay.reasons.join()).toContain("original-only.txt");
  expect(
    (await readManifest(replay.directory ?? "")).artifacts.some(
      (a) => a.source_path === "original-only.txt",
    ),
  ).toBe(false);
  expect(await hashes(recorder.directory)).toEqual(before);
}, 120000);
