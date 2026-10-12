import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { demo } from "../../src/cli";
import { dockerCommand } from "../../src/execution/docker";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";
import { DockerSession } from "../../src/execution/session";
import { exportNotebooks } from "../../src/records/notebook";
import { replayRun } from "../../src/records/replay";
import {
  RunRecorder,
  readArtifact,
  readEvents,
  readManifest,
} from "../../src/records/store";

async function snapshots(directory: string): Promise<Record<string, string>> {
  const files = [
    "manifest.json",
    "events.jsonl",
    ...(await readdir(join(directory, "artifacts"))).map(
      (name) => `artifacts/${name}`,
    ),
    ...(await readdir(join(directory, "notebooks"))).map(
      (name) => `notebooks/${name}`,
    ),
  ];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex"),
      ]),
    ),
  );
}

describe("host records with real Docker", () => {
  test("forced termination preserves collected snapshots and marks remaining workspace unknown", async () => {
    const runRoot = resolve("runs/integration-records");
    const runId = randomUUID();
    const config = {
      run_id: runId,
      image: process.env.STATIGENT_TEST_IMAGE ?? "statigent-runtime:dev",
      input_root: resolve("tests/fixtures"),
      inputs: [],
      staging_root: join(runRoot, ".staging"),
      seed: 42,
      limits: {
        ...DEFAULT_LIMITS,
        cell_timeout_ms: 1000,
        interrupt_grace_ms: 500,
      },
    };
    const recorder = await RunRecorder.create({
      runRoot,
      runId,
      config,
      inputs: [],
      image: { id: "unresolved", platform: "unresolved" },
      seed: 42,
    });
    const session = await DockerSession.create(config, recorder);
    try {
      const first = await session.execute(
        'from pathlib import Path\nPath("saved.txt").write_text("collected before failure")',
      );
      expect(first.status).toBe("ok");
      const reference = recorder.manifest.artifacts.find(
        (ref) => ref.source_path === "saved.txt",
      );
      expect(reference).toBeDefined();
      if (!reference) throw new Error("Missing collected artifact");
      const before = await readArtifact(recorder.directory, reference);
      const result = await session.execute(
        'import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nPath("uncollected.txt").write_text("not promised")\nwhile True: time.sleep(0.1)',
      );
      expect(result.status).toBe("timed_out");
      expect(result.kernel_available).toBe(false);
      expect(await readArtifact(recorder.directory, reference)).toEqual(before);
    } finally {
      await session.close();
    }
    await recorder.finish("failed");
    await exportNotebooks(recorder.directory);
    const manifest = await readManifest(recorder.directory);
    expect(manifest.status).toBe("failed");
    expect(manifest.workspace_collection.status).toBe("incomplete_or_unknown");
    expect(
      manifest.artifacts.some((ref) => ref.source_path === "saved.txt"),
    ).toBe(true);
    expect(manifest.replay.eligible).toBe(false);
    expect(
      await dockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=org.statigent.run=${runId}`,
      ]),
    ).toBe("");
  }, 90000);
  test("replay cannot read original intermediate files and reports the failed cell independently", async () => {
    const runRoot = resolve("runs/integration-records");
    const runId = randomUUID();
    const config = {
      run_id: runId,
      image: process.env.STATIGENT_TEST_IMAGE ?? "statigent-runtime:dev",
      input_root: resolve("tests/fixtures"),
      inputs: ["synthetic.csv"],
      staging_root: join(runRoot, ".staging"),
      seed: 42,
      limits: { ...DEFAULT_LIMITS },
    };
    const recorder = await RunRecorder.create({
      runRoot,
      runId,
      config,
      inputs: [],
      image: { id: "unresolved", platform: "unresolved" },
      seed: 42,
    });
    const session = await DockerSession.create(config, recorder);
    try {
      // Deliberately seed unrecorded state to prove replay never mounts the original workspace.
      await dockerCommand([
        "exec",
        session.containerName,
        "sh",
        "-c",
        "printf synthetic > /workspace/original-only.txt",
      ]);
      const result = await session.execute(
        'from pathlib import Path\nassert Path("original-only.txt").read_text() == "synthetic"',
      );
      expect(result.status).toBe("ok");
    } finally {
      await session.close();
    }
    await recorder.finish("completed");
    await exportNotebooks(recorder.directory);
    const before = await snapshots(recorder.directory);
    const replay = await replayRun(recorder.directory, runRoot);
    expect(replay.status).toBe("failed");
    expect(replay.failed_cell).toBeString();
    expect(replay.reasons.join(" ")).toContain("original-only.txt");
    expect(await snapshots(recorder.directory)).toEqual(before);
    if (!replay.directory) throw new Error("Missing replay record");
    const result = await readManifest(replay.directory);
    expect(result.replay.result).toBe("failed");
    expect(result.replay_of).toBe(runId);
    expect(result.timing.execution_count).toBe(1);
  }, 180000);
  test("synthetic statistics, PNG, notebook and independent replay preserve original files", async () => {
    const result = await demo(
      resolve("runs/integration-records"),
      process.env.STATIGENT_TEST_IMAGE ?? "statigent-runtime:dev",
    );
    const manifest = await readManifest(result.directory);
    expect(result.results[1]?.preview).toContain('"A":2.0');
    expect(result.results[1]?.preview).toContain('"B":4.0');
    expect(manifest.image.platform).toMatch(/^linux\/(arm64|amd64)$/);
    expect(manifest.environment.docker_version).toBeString();
    const png = manifest.artifacts.find(
      (ref) => ref.source_path === "means.png",
    );
    expect(png).toBeDefined();
    if (!png) throw new Error("Missing PNG");
    const data = await readArtifact(result.directory, png);
    expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const check = Bun.spawn(
      [
        "uv",
        "run",
        "--frozen",
        "python",
        "-c",
        "import sys; from PIL import Image; Image.open(sys.argv[1]).verify()",
        join(result.directory, png.path),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const error = await new Response(check.stderr).text();
    expect(await check.exited, error).toBe(0);
    expect(manifest.export.status).toBe("exported");
    expect(manifest.replay.eligible).toBe(true);
    expect(manifest.timing.execution_count).toBe(3);
    const events = await readEvents(result.directory);
    const sequence = events
      .filter((event) => event.type === "dispatch")
      .map((event) => event.execution_seq);
    expect(sequence).toEqual([1, 2, 3]);
    const before = await snapshots(result.directory);
    const replay = await replayRun(
      result.directory,
      resolve("runs/integration-records"),
    );
    expect(replay.status, replay.reasons.join("\n")).toBe("passed");
    expect(replay.run_id).not.toBe(result.run_id);
    expect(await snapshots(result.directory)).toEqual(before);
    if (!replay.directory) throw new Error("Missing replay directory");
    const replayManifest = await readManifest(replay.directory);
    expect(replayManifest.replay_of).toBe(result.run_id);
    expect(replayManifest.timing.execution_count).toBe(3);
    expect(replayManifest.inputs).toEqual(manifest.inputs);
    expect(replayManifest.image.id).toBe(manifest.image.id);
  }, 180000);
});
