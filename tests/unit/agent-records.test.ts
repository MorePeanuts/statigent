import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import profiles from "../../configs/models.json";
import { DEFAULT_BUDGET } from "../../src/agent/config";
import { validateProfile } from "../../src/models/config";
import { buildNotebooks, exportNotebooks } from "../../src/records/notebook";
import {
  RunRecorder,
  readArtifact,
  readEvents,
  readManifest,
} from "../../src/records/store";
export async function agentRecorder(root: string, max = 100000) {
  return RunRecorder.create({
    runRoot: root,
    config: {},
    inputs: [],
    image: { id: "test", platform: "linux/arm64" },
    maxTotalArtifactBytes: 1,
    agent: {
      model: {
        profile: validateProfile(profiles[0]),
        returned_models: [],
        response_ids: [],
        fingerprints: [],
      },
      prompt: { version: "test", sha256: "a".repeat(64) },
      tokens: {
        status: "known",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        attempts: 0,
        unknown_attempts: 0,
        elapsed_ms: 0,
        currency_cost: "not_computed",
      },
      metadata: {
        goal: "test",
        constraints: [],
        budget: { ...DEFAULT_BUDGET, max_trace_bytes: max },
        remaining: {
          model_attempts: 12,
          executions: 8,
          tokens: 100000,
          task_ms: 300000,
        },
        executions: 0,
        termination: null,
        final_result: null,
        trace_bytes: 0,
        trace_incomplete: false,
      },
    },
  });
}
test("legacy read and export preserve original files; v2 metadata strict", async () => {
  const root = await mkdtemp(join(tmpdir(), "statigent-v1-"));
  try {
    await cp("tests/fixtures/legacy-run", root, { recursive: true });
    await mkdir(join(root, "notebooks"), { recursive: true });
    const original = await readFile(join(root, "manifest.json"));
    const journal = await readFile(join(root, "events.jsonl"));
    expect((await readManifest(root)).schema_version).toBe(1);
    expect((await exportNotebooks(root, async () => {})).status).toBe(
      "exported",
    );
    expect(await readFile(join(root, "manifest.json"))).toEqual(original);
    expect(await readFile(join(root, "events.jsonl"))).toEqual(journal);
    const rec = await agentRecorder(root);
    expect((await readManifest(rec.directory)).run_kind).toBe("agent");
    const changed = JSON.parse(
      await Bun.file(join(rec.directory, "manifest.json")).text(),
    );
    changed.tokens.currency_cost = 0;
    await writeFile(
      join(rec.directory, "manifest.json"),
      JSON.stringify(changed),
    );
    await expect(readManifest(rec.directory)).rejects.toThrow(
      "Invalid token status",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("model journal separate quotas and notebook terminals; fail closed on persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "statigent-model-record-"));
  try {
    const rec = await agentRecorder(root, 100);
    await rec.modelEvent(
      "model_request",
      { attempt_id: "a" },
      { messages: ["task"] },
    );
    await rec.modelEvent(
      "model_response",
      { attempt_id: "a", response_id: "server-a" },
      { status: "ok" },
    );
    const events = await readEvents(rec.directory);
    expect(
      JSON.parse(
        (await readArtifact(rec.directory, events[0]?.content_ref)).toString(),
      ),
    ).toEqual({ messages: ["task"] });
    expect(buildNotebooks(events, rec.manifest.run_id).notebooks.size).toBe(0);
    expect(rec.manifest.timing.execution_count).toBe(0);
    await expect(
      rec.modelEvent("model_response", {}, "x".repeat(100)),
    ).rejects.toThrow("persistence failed");
    await expect(rec.modelEvent("model_request", {})).rejects.toThrow(
      "persistence failed",
    );
    expect((await readManifest(rec.directory)).agent).toMatchObject({
      trace_incomplete: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
