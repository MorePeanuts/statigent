import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";
import {
  buildNotebooks,
  exportNotebooks,
  validateNotebook,
} from "../../src/records/notebook";
import { replayRun } from "../../src/records/replay";
import {
  RunRecorder,
  readArtifact,
  readEvents,
  readManifest,
  sha256,
} from "../../src/records/store";

const roots: string[] = [];
async function recorder() {
  const root = await mkdtemp(join(tmpdir(), "statigent-records-"));
  roots.push(root);
  return RunRecorder.create({
    runRoot: root,
    runId: "test-run",
    config: { api_key: "fake-secret", limits: { memory: 42 } },
    image: { id: "sha256:test", platform: "linux/arm64" },
    inputs: [],
  });
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function event(type: string, fields: Record<string, unknown> = {}) {
  return {
    type,
    at: new Date().toISOString(),
    run_id: "test-run",
    session_id: "session-1",
    ...fields,
  };
}
function dispatch(request: string, seq: number, code: string, epoch = 1) {
  return event("dispatch", {
    request: {
      request_id: request,
      cell_id: `cell-${seq}`,
      kernel_epoch: epoch,
      execution_seq: seq,
      code,
    },
  });
}
function finish(
  request: string,
  status = "ok",
  more: Record<string, unknown> = {},
) {
  return event("finish", {
    result: {
      request_id: request,
      started: true,
      status,
      persistence_complete: true,
      elapsed_ms: 10,
      waiting_ms: 5,
      ...more,
    },
  });
}
function output(request: string, value: Record<string, unknown>) {
  return event("output", { message: { request_id: request, output: value } });
}

describe("host records", () => {
  test("dispatch intent cancelled before send has no actual execution count", () => {
    const view = buildNotebooks(
      [
        dispatch("a", 1, "side_effect()"),
        finish("a", "cancelled", { started: false }),
      ],
      "test",
    );
    const cell = view.notebooks.get(1)?.cells[0];
    expect(cell?.execution_count).toBeNull();
    expect(cell?.metadata.statigent.execution_seq).toBeUndefined();
    expect(cell?.metadata.statigent.started).toBe(false);
  });
  test("forced termination marks uncollected files unknown and cannot finish successfully", async () => {
    const rec = await recorder();
    await rec.onEvent(
      event("failure", {
        status: "kernel_lost",
        message: "container terminated",
      }),
    );
    await rec.onEvent(event("close", { status: "kernel_lost", elapsed_ms: 4 }));
    await rec.finish("completed");
    const manifest = await readManifest(rec.directory);
    expect(manifest.workspace_collection.status).toBe("incomplete_or_unknown");
    expect(manifest.status).toBe("kernel_lost");
  });
  test("incomplete final journal line cannot manufacture completion", async () => {
    const rec = await recorder();
    await rec.onEvent(dispatch("a", 1, ""));
    const path = join(rec.directory, "events.jsonl");
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}{"type":"finish","result":`);
    const view = buildNotebooks(
      await readEvents(rec.directory),
      rec.manifest.run_id,
    );
    expect(view.reasons).toContain("journal_truncated");
    expect(view.reasons).toContain("unfinished_execution");
    expect(view.notebooks.get(1)?.cells[0]?.source).toBe("");
  });
  test("late output remains with original request after a second cell starts", async () => {
    const rec = await recorder();
    await rec.onEvent(dispatch("a", 1, "print(1)"));
    await rec.onEvent(finish("a"));
    await rec.onEvent(dispatch("b", 2, "print(2)"));
    await rec.onEvent(
      output("a", {
        output_type: "stream",
        name: "stdout",
        text: "late first",
      }),
    );
    await rec.onEvent(
      output("b", { output_type: "stream", name: "stdout", text: "second" }),
    );
    await rec.onEvent(finish("b"));
    const view = buildNotebooks(await readEvents(rec.directory), "test-run");
    expect(view.notebooks.get(1)?.cells[0]?.outputs[0]?.text).toBe(
      "late first",
    );
    expect(view.notebooks.get(1)?.cells[1]?.outputs[0]?.text).toBe("second");
  });
  test("input mismatch leaves an independent failed replay and never changes source records", async () => {
    const root = await mkdtemp(join(tmpdir(), "statigent-replay-"));
    roots.push(root);
    const inputRoot = join(root, "input");
    await mkdir(inputRoot);
    await writeFile(join(inputRoot, "data.csv"), "changed");
    const config = {
      run_id: "test-run",
      image: "missing-image",
      input_root: inputRoot,
      inputs: ["data.csv"],
      staging_root: join(root, ".staging"),
      seed: 42,
      limits: DEFAULT_LIMITS,
    };
    const rec = await RunRecorder.create({
      runRoot: join(root, "runs"),
      runId: "test-run",
      config,
      inputs: [
        {
          path: "data.csv",
          sha256: sha256(Buffer.from("original")),
          size_bytes: 8,
        },
      ],
      image: { id: "sha256:original", platform: "linux/arm64" },
      seed: 42,
    });
    await rec.onEvent(dispatch("a", 1, "print(1)"));
    await rec.onEvent(finish("a"));
    await rec.finish("completed");
    const before = await readFile(join(rec.directory, "manifest.json"), "utf8");
    const replay = await replayRun(rec.directory, join(root, "runs"));
    expect(replay.status).toBe("failed");
    expect(replay.reasons.join(" ")).toContain("checksum mismatch");
    expect(replay.run_id).not.toBe("test-run");
    expect(await readFile(join(rec.directory, "manifest.json"), "utf8")).toBe(
      before,
    );
    expect(replay.directory).toBeDefined();
    if (!replay.directory) throw new Error("Missing independent result");
    const replayManifest = await readManifest(replay.directory);
    expect(replayManifest.replay.result).toBe("failed");
    expect(replayManifest.timing.execution_count).toBe(0);
    expect(replayManifest.replay_of).toBe("test-run");
  });
  test("retains failure and repair as separate cells, redacts config, and counts only actual execution", async () => {
    const rec = await recorder();
    await rec.onEvent(dispatch("r1", 1, 'x = 2\nraise ValueError("oops")'));
    await rec.onEvent(
      output("r1", {
        output_type: "error",
        ename: "ValueError",
        evalue: "oops",
        traceback: ["trace"],
      }),
    );
    await rec.onEvent(finish("r1", "error"));
    await rec.onEvent(dispatch("r2", 2, "print(x)"));
    await rec.onEvent(
      output("r2", { output_type: "stream", name: "stdout", text: "2\n" }),
    );
    await rec.onEvent(finish("r2"));
    await rec.onEvent(
      finish("r3", "cancelled", { started: false, elapsed_ms: 0 }),
    );
    await rec.finish("completed");
    const manifest = await readManifest(rec.directory);
    expect(manifest.config.api_key).toBe("[REDACTED]");
    expect(manifest.model).toBe("not_applicable");
    expect(manifest.timing.execution_count).toBe(2);
    expect(manifest.timing.execution_ms).toBe(20);
    expect(manifest.timing.wait_ms).toBe(15);
    const view = buildNotebooks(
      await readEvents(rec.directory),
      manifest.run_id,
    );
    expect(view.eligible).toBe(false);
    expect(view.notebooks.get(1)?.cells.length).toBe(2);
    expect(view.notebooks.get(1)?.cells[0]?.outputs[0]?.output_type).toBe(
      "error",
    );
    expect(
      (await readFile(join(rec.directory, "events.jsonl"), "utf8")).includes(
        "output_ref",
      ),
    ).toBe(true);
  });
  test("interrupted dispatch remains unknown, epochs remain separate", async () => {
    const view = buildNotebooks(
      [
        dispatch("a", 1, "x=1"),
        event("restart"),
        dispatch("b", 2, "x=2", 2),
        finish("b"),
      ],
      "test",
    );
    expect(view.notebooks.size).toBe(2);
    expect(view.reasons).toContain("unfinished_execution");
    expect(view.notebooks.get(1)?.cells[0]?.metadata.statigent.status).toBe(
      "unknown",
    );
  });
  test("applies display update across cells and deferred clear without deleting raw events", () => {
    const events = [
      dispatch("a", 1, "display()"),
      output("a", {
        output_type: "display_data",
        data: { "text/plain": "old" },
        metadata: {},
        transient: { display_id: "plot" },
      }),
      finish("a"),
      dispatch("b", 2, "update()"),
      output("b", {
        output_type: "update_display_data",
        data: { "text/plain": "new" },
        metadata: {},
        transient: { display_id: "plot" },
      }),
      output("b", {
        output_type: "stream",
        name: "stdout",
        text: "old stream",
      }),
      output("b", { output_type: "clear_output", wait: true }),
      output("b", {
        output_type: "stream",
        name: "stdout",
        text: "new stream",
      }),
      finish("b"),
    ];
    const cells = buildNotebooks(events, "test").notebooks.get(1)?.cells;
    expect(cells?.[0]?.outputs[0]?.data).toEqual({ "text/plain": "new" });
    expect(cells?.[1]?.outputs).toHaveLength(1);
    expect(cells?.[1]?.outputs[0]?.text).toBe("new stream");
    expect(events).toHaveLength(9);
  });
  test("preview truncation preserves eligibility but persisted truncation and failures do not", () => {
    expect(
      buildNotebooks(
        [
          dispatch("a", 1, "print(1)"),
          finish("a", "ok", { preview_truncated: true }),
        ],
        "x",
      ).eligible,
    ).toBe(true);
    expect(
      buildNotebooks(
        [
          dispatch("a", 1, "print(1)"),
          finish("a", "ok", { persistence_complete: false }),
        ],
        "x",
      ).reasons,
    ).toContain("persistence_incomplete");
    expect(
      buildNotebooks(
        [dispatch("a", 1, "print(1)"), finish("a", "timed_out")],
        "x",
      ).eligible,
    ).toBe(false);
  });
  test("artifact snapshots use host IDs, preserve empty files, and verify integrity", async () => {
    const rec = await recorder();
    const a = await rec.onArtifact({
      path: "plot.png",
      mime_type: "image/png",
      data_base64: Buffer.from("a").toString("base64"),
      cell_id: "c1",
    });
    const b = await rec.onArtifact({
      path: "plot.png",
      mime_type: "image/png",
      data_base64: Buffer.from("b").toString("base64"),
      cell_id: "c2",
    });
    const empty = await rec.onArtifact({
      path: "empty.txt",
      mime_type: "text/plain",
      data_base64: "",
    });
    expect(a.artifact_id).not.toBe(b.artifact_id);
    expect((await readArtifact(rec.directory, a)).toString()).toBe("a");
    expect((await readArtifact(rec.directory, b)).toString()).toBe("b");
    expect(empty.size_bytes).toBe(0);
    expect(empty.sha256).toBe(sha256(Buffer.from("")));
    await writeFile(join(rec.directory, b.path), "tampered");
    await expect(readArtifact(rec.directory, b)).rejects.toThrow("integrity");
  });
  test("rejects path traversal and fails closed for subsequent events", async () => {
    const rec = await recorder();
    await expect(
      rec.onArtifact({
        path: "../escape",
        mime_type: "text/plain",
        data_base64: "YQ==",
      }),
    ).rejects.toThrow("persistence failed");
    await expect(rec.onEvent(dispatch("a", 1, "print(1)"))).rejects.toThrow(
      "persistence failed",
    );
    expect(await readEvents(rec.directory)).toEqual([]);
  });
  test("record I/O failure refuses further dispatches", async () => {
    const rec = await recorder();
    await rm(join(rec.directory, "events.jsonl"));
    await mkdir(join(rec.directory, "events.jsonl"));
    await expect(rec.onEvent(dispatch("a", 1, "print(1)"))).rejects.toThrow(
      "persistence failed",
    );
    await expect(rec.onEvent(dispatch("b", 2, "print(2)"))).rejects.toThrow(
      "persistence failed",
    );
  });
  test("exports valid notebook, independent statuses and no overwritten earlier export", async () => {
    const rec = await recorder();
    await rec.onEvent(dispatch("a", 1, "print(1)"));
    await rec.onEvent(
      output("a", { output_type: "stream", name: "stdout", text: "1\n" }),
    );
    await rec.onEvent(finish("a"));
    await rec.finish("completed");
    const first = await exportNotebooks(rec.directory);
    const second = await exportNotebooks(rec.directory);
    expect(first.paths[0]).not.toBe(second.paths[0]);
    expect((await readManifest(rec.directory)).replay.result).toBe(
      "not_requested",
    );
    const notebook = JSON.parse(
      await readFile(join(rec.directory, first.paths[0] ?? ""), "utf8"),
    );
    await validateNotebook(notebook);
  });
});
