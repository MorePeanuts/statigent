import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../../configs/tasks/collaboration-report.json";
import { checkCollaborationEvidence } from "../../src/agent/collaboration-smoke";
import { runAgent } from "../../src/agent/run";
import { exportNotebooks } from "../../src/records/notebook";
import { fakeRuntime, profile, ScriptClient } from "../helpers/agent";
import { collaborationScript } from "../helpers/collaboration-script";
import { png } from "../helpers/images";

test("collaboration smoke verifier requires real delegation/state evidence and correct report", async () => {
  const root = await mkdtemp(join(tmpdir(), "collaboration-smoke-"));
  try {
    const runtime = fakeRuntime();
    const result = await runAgent({
      task: config,
      profile,
      runRoot: root,
      client: new ScriptClient(collaborationScript()),
      createSession: async (c, r) => {
        const session = await runtime.createSession(c, r);
        return {
          ...session,
          execute: async (code, opts) => {
            const result = await session.execute(code, opts);
            const image = await r.onArtifact({
              path: "means.png",
              mime_type: "image/png",
              data_base64: png(1, 1).toString("base64"),
              cell_id: result.cell_id,
            });
            return { ...result, artifacts: [image] };
          },
        };
      },
      export: (dir, _, status) => exportNotebooks(dir, async () => {}, status),
    });
    expect(result.status, result.reason).toBe("completed");
    const accepted = await checkCollaborationEvidence(result);
    expect(accepted.completed_subtasks).toBe(2);
    expect(accepted.state_witnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "means",
          from_subtask: expect.any(String),
        }),
      ]),
    );
    const wrong = structuredClone(result);
    if (!wrong.analysis?.report) throw new Error("Report required");
    wrong.analysis.report.images = [];
    await expect(checkCollaborationEvidence(wrong)).rejects.toThrow("images");
    const finding = wrong.analysis.findings[0];
    if (!finding) throw new Error("Finding required");
    finding.value = {
      group_means: { A: 9, B: 4 },
      centered_values: [-2, 2],
    };
    await expect(checkCollaborationEvidence(wrong)).rejects.toThrow("expected");
    const path = join(result.directory, "manifest.json");
    const manifest = await Bun.file(path).json();
    manifest.collaboration.subtasks[0].status = "partial";
    await Bun.write(path, JSON.stringify(manifest));
    await expect(checkCollaborationEvidence(result)).rejects.toThrow(
      "Two completed",
    );
    manifest.collaboration.subtasks[0].status = "completed";
    await Bun.write(path, JSON.stringify(manifest));
    const eventPath = join(result.directory, "events.jsonl");
    const original = await Bun.file(eventPath).text();
    await Bun.write(
      eventPath,
      original
        .split("\n")
        .map((line) => {
          if (!line) return line;
          const e = JSON.parse(line);
          if (e.type === "dispatch" && e.request.execution_seq === 2)
            e.request.code = "print(1)";
          return JSON.stringify(e);
        })
        .join("\n"),
    );
    await expect(checkCollaborationEvidence(result)).rejects.toThrow(
      "No cross-delegation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
