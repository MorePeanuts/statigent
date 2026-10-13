import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyLedger,
  validateAgentFields,
} from "../../src/records/agent-metadata";
import { CollaborationJournal } from "../../src/records/collaboration-journal";
import { exportNotebooks } from "../../src/records/notebook";
import {
  inspectModelJournal,
  readEvents,
  readManifest,
} from "../../src/records/store";
import { collaborationRecorder } from "../helpers/collaboration";

test("v4 role identities and task totals are validated without changing v2", async () => {
  const root = await mkdtemp(join(tmpdir(), "roles-record-"));
  try {
    const rec = await collaborationRecorder(root);
    const manifest = await readManifest(rec.directory);
    expect(manifest.schema_version).toBe(4);
    expect(manifest.collaboration?.roles.executor.model.profile).toEqual(
      manifest.collaboration?.roles.planner.model.profile,
    );
    const raw = JSON.parse(JSON.stringify(manifest));
    raw.tokens.attempts = 1;
    expect(() => validateAgentFields(raw)).toThrow("Role totals");
    raw.collaboration.roles.planner.tokens.attempts = 1;
    raw.collaboration.roles.planner.tokens.unknown_attempts = 1;
    raw.collaboration.roles.planner.tokens.status = "unknown";
    raw.tokens.unknown_attempts = 1;
    raw.tokens.status = "unknown";
    expect(() => validateAgentFields(raw)).not.toThrow();
    const task = {
      subtask_id: "s1",
      tool_id: "t1",
      status: "running",
      tokens: emptyLedger(),
      evidence_refs: [],
    };
    raw.collaboration.subtasks = [task, task];
    expect(() => validateAgentFields(raw)).toThrow("Duplicate subtask");
    raw.collaboration.subtasks = [];
    raw.schema_version = 2;
    expect(() => validateAgentFields(raw)).toThrow("requires manifest v3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delegation journal rejects routing errors and retains unresolved executor intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "roles-journal-"));
  try {
    const rec = await collaborationRecorder(root);
    await rec.modelEvent(
      "subtask_delegated",
      { role: "planner", subtask_id: "s1", tool_id: "d1" },
      { task: "Compute" },
    );
    await rec.modelEvent(
      "model_request",
      { role: "executor", subtask_id: "s1", attempt_id: "a1" },
      { messages: [] },
    );
    const before = await readFile(join(rec.directory, "events.jsonl"));
    expect(await inspectModelJournal(rec.directory)).toMatchObject({
      unresolved_roles: [
        { attempt_id: "a1", role: "executor", subtask_id: "s1" },
      ],
      active_subtask: "s1",
    });
    expect(await readFile(join(rec.directory, "events.jsonl"))).toEqual(before);
    const journal = new CollaborationJournal();
    for (const event of await readEvents(rec.directory))
      journal.accept(String(event.type), event);
    expect(() =>
      journal.accept("subtask_returned", {
        role: "executor",
        subtask_id: "other",
      }),
    ).toThrow("mismatch");
    journal.accept("model_response", {
      role: "executor",
      subtask_id: "s1",
      attempt_id: "a1",
    });
    journal.accept("subtask_returned", { role: "executor", subtask_id: "s1" });
    expect(() =>
      journal.accept("subtask_returned", {
        role: "executor",
        subtask_id: "s1",
      }),
    ).toThrow();
    expect(() =>
      journal.accept("subtask_delegated", {
        role: "planner",
        subtask_id: "s1",
        tool_id: "d2",
      }),
    ).toThrow("duplicate");
    // A failed write poisons the recorder before any downstream dispatch can occur.
    await rm(join(rec.directory, "events.jsonl"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(rec.directory, "events.jsonl"));
    await expect(
      rec.modelEvent("model_failure", {
        role: "executor",
        subtask_id: "s1",
        attempt_id: "a1",
      }),
    ).rejects.toThrow("persistence failed");
    await expect(
      rec.modelEvent("subtask_returned", {
        role: "executor",
        subtask_id: "s1",
      }),
    ).rejects.toThrow("persistence failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v4 inspection and notebook export keep host report out of execution cells", async () => {
  const root = await mkdtemp(join(tmpdir(), "roles-export-"));
  try {
    const rec = await collaborationRecorder(root);
    await rec.finish("failed");
    const before = await readFile(join(rec.directory, "events.jsonl"));
    await exportNotebooks(rec.directory, async () => {});
    expect((await readManifest(rec.directory)).schema_version).toBe(4);
    expect(await readFile(join(rec.directory, "events.jsonl"))).toEqual(before);
    const raw = JSON.parse(
      await Bun.file(join(rec.directory, "manifest.json")).text(),
    );
    raw.schema_version = "3";
    await writeFile(join(rec.directory, "manifest.json"), JSON.stringify(raw));
    await expect(readManifest(rec.directory)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
