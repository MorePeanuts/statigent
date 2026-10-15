import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methodManifest } from "../../src/baselines/catalog";
import {
  BaselineRecorder,
  readBaselineRecord,
} from "../../src/baselines/records";
import { emptyUsage } from "../../src/evaluation/contracts";

test("ordered independent baseline records and bounded logs preserve failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseline-records-"));
  try {
    const recorder = await BaselineRecorder.create(
      join(root, "one"),
      {
        run_id: "run",
        unit_id: "unit",
        method: methodManifest("autogluon"),
        config_hash: "a".repeat(64),
        environment: {},
      },
      1024,
    );
    await Promise.all([
      recorder.event("start", { stage: "training" }),
      recorder.event("end", { stage: "training" }),
    ]);
    const events = (await readFile(join(root, "one/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.map((x) => x.sequence)).toEqual([1, 2]);
    await expect(
      recorder.event("large", { data: "x".repeat(2048) }),
    ).rejects.toThrow();
    await recorder.finish({
      status: "completed",
      reason: "done",
      usage: emptyUsage("not_applicable"),
      cleanup_error: null,
    });
    const result = await readBaselineRecord(join(root, "one"));
    expect(result.status).toBe("failed");
    expect(result.record_error).toBe(true);
    expect(result.usage.source).toBe("not_applicable");
    expect(result.event_count).toBe(2);
    await expect(recorder.event("late", {})).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
