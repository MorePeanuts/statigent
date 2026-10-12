import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  returnedImages,
  validatePlannerReport,
} from "../../src/agent/collaboration-report";
import { validateTask } from "../../src/agent/config";
import { runAgent } from "../../src/agent/run";
import { deliverReport } from "../../src/evaluation/agents/statigent";
import { exportNotebooks } from "../../src/records/notebook";
import {
  RunRecorder,
  readArtifact,
  readManifest,
} from "../../src/records/store";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";
import { collaborationRecorder, returned } from "../helpers/collaboration";
import { jpeg, png } from "../helpers/images";

const spec = {
  image_types: ["png", "jpeg"] as ("png" | "jpeg")[],
  max_images: 2,
  max_image_bytes: 4096,
  max_report_bytes: 4096,
};

test("planner image aliases bind snapshots and enforce visibility and report limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "planner-images-"));
  try {
    const rec = await collaborationRecorder(root);
    const save = (data: Buffer, path = "chart.png", mime_type = "image/png") =>
      rec.onArtifact({
        path,
        mime_type,
        data_base64: data.toString("base64"),
        cell_id: "cell-1",
      });
    const first = await save(png(1, 1));
    const descriptors = await returnedImages(
      rec.directory,
      rec.manifest.artifacts,
      [first.artifact_id],
    );
    const image = descriptors[0];
    if (!image) throw new Error("Missing image");
    const visible = new Map(descriptors.map((i) => [i.reference, i]));
    const later = await save(png(2, 2));
    const markdown = `# Exact report\n![chart](${image.reference})`;
    const check = (text: string, limits = spec) =>
      validatePlannerReport(
        text,
        rec.directory,
        rec.manifest.artifacts,
        visible,
        limits,
      );
    expect((await check(markdown))[0]?.artifact_id).toBe(first.artifact_id);
    expect((await check(markdown))[0]?.artifact_id).not.toBe(later.artifact_id);
    for (const path of [
      "https://example.com/x.png",
      "../x.png",
      "/x.png",
      `images/${later.artifact_id}.png`,
      "missing.png",
    ])
      await expect(check(`![x](${path})`)).rejects.toThrow();
    await expect(check(markdown, { ...spec, max_images: 0 })).rejects.toThrow(
      "too many",
    );
    await expect(
      check(markdown, { ...spec, max_image_bytes: 1 }),
    ).rejects.toThrow("size");
    await expect(
      check(markdown, { ...spec, max_report_bytes: 1 }),
    ).rejects.toThrow("size");
    const j = await save(jpeg(1, 1), "j.jpg", "image/jpeg");
    const js = await returnedImages(rec.directory, rec.manifest.artifacts, [
      j.artifact_id,
    ]);
    const ji = js[0];
    if (!ji) throw new Error("Missing jpeg");
    visible.set(ji.reference, ji);
    await expect(
      check(`![j](${ji.reference})`, { ...spec, image_types: ["png"] }),
    ).rejects.toThrow("format");
    const saved = await rec.savePlannerReport(markdown, {
      role: "planner",
      attempt_id: "a1",
      tool_id: "f1",
    });
    expect((await readArtifact(rec.directory, saved)).toString()).toBe(
      markdown,
    );
    expect(saved.cell_id).toBeUndefined();
    expect(saved.source_path).toBeUndefined();
    expect(
      (await readManifest(rec.directory)).artifacts.at(-1)?.origin?.role,
    ).toBe("planner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner authored report finishes and delivers pinned images; failed storage never completes", async () => {
  for (const fail of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "planner-report-"));
    try {
      let markdown = "";
      const client = new ScriptClient((b, i) => {
        if (i === 0)
          return reply([
            call("delegate_analysis", {
              task: "Compute and plot means",
              constraints: [],
            }),
          ]);
        if (i === 1)
          return reply([call("execute_python", { code: "chart()" })]);
        if (i === 2) {
          const f = lastFeedback(b);
          const artifacts = f.artifacts as { artifact_id: string }[];
          return reply([
            returned(b, [String(f.cell_id), String(artifacts[0]?.artifact_id)]),
          ]);
        }
        const f = lastFeedback(b);
        const images = f.images as { reference: string }[];
        markdown = `# Planner report\n![means](${images[0]?.reference})`;
        const action = finish("cell-1");
        const args = JSON.parse(action.function.arguments);
        return reply([
          call("finish_analysis", { ...args, report_markdown: markdown }),
        ]);
      });
      const runtime = fakeRuntime();
      const result = await runAgent({
        task: { ...task, organization: "planner-executor", report: spec },
        profile,
        client,
        runRoot: root,
        createSession: async (c, r) => {
          const session = await runtime.createSession(c, r);
          return {
            ...session,
            execute: async (code, opts) => {
              const result = await session.execute(code, opts);
              const ref = await r.onArtifact({
                path: "chart.png",
                mime_type: "image/png",
                data_base64: png(1, 1).toString("base64"),
                cell_id: result.cell_id,
              });
              return { ...result, artifacts: [ref] };
            },
          };
        },
        createRecorder: async (o) => {
          const rec = await RunRecorder.create(o);
          if (fail)
            rec.savePlannerReport = async () => {
              throw new Error("disk failure");
            };
          return rec;
        },
        export: (dir, _, status) =>
          exportNotebooks(dir, async () => {}, status),
      });
      if (fail) {
        expect(result.status).toBe("failed");
        expect(result.analysis).toBeNull();
        continue;
      }
      expect(result.status).toBe("completed");
      const manifest = await readManifest(result.directory);
      const ref = manifest.artifacts.find(
        (a) => a.artifact_id === result.analysis?.report?.artifact_id,
      );
      expect((await readArtifact(result.directory, ref)).toString()).toBe(
        markdown,
      );
      expect(ref?.origin?.role).toBe("planner");
      expect(manifest.timing.execution_count).toBe(1);
      const delivered = join(root, "delivered");
      await deliverReport(
        result.directory,
        result.analysis,
        "report.md",
        delivered,
      );
      expect(await Bun.file(join(delivered, "report.md")).text()).toBe(
        markdown,
      );
      expect(
        await Bun.file(
          join(
            delivered,
            result.analysis?.report?.images[0]?.reference ?? "missing",
          ),
        ).exists(),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("documented dual report example uses effective host artifact limits", async () => {
  const task = validateTask(
    await Bun.file("configs/tasks/collaboration-report.json").json(),
  );
  expect(task.organization).toBe("planner-executor");
  expect(task.report?.max_report_bytes).toBeLessThanOrEqual(
    task.execution.limits.max_artifact_bytes,
  );
  expect(await Bun.file("docs/agent.md").text()).toContain(
    "configs/tasks/collaboration-report.json",
  );
});
