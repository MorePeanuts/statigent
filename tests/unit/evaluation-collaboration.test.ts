import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statigentAdapter } from "../../src/evaluation/agents/statigent";
import { exportNotebooks } from "../../src/records/notebook";
import { readManifest } from "../../src/records/store";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { returned, twoSubtasks } from "../helpers/collaboration";
import { invocation } from "../helpers/evaluation";
import { png } from "../helpers/images";

test("adapter validates organization and restricted native budgets before invocation", async () => {
  const adapter = statigentAdapter({
    overrides: { client: new ScriptClient(twoSubtasks) },
    image: async () => ({ id: "test", platform: "linux/arm64" }),
  });
  expect(adapter.options({ image: "test" })).toMatchObject({
    organization: "single",
    budget: { executions: 8 },
  });
  for (const budget of [
    { total_tokens: 999999 },
    { model_attempts: 99 },
    { task_timeout_ms: 99 },
    { executions: 0 },
    { executions: 1.5 },
  ])
    expect(() => adapter.options({ image: "test", budget })).toThrow();
  expect(() =>
    adapter.options({ image: "test", organization: "other" }),
  ).toThrow();
  const config = {
    ...invocation("/tmp").config,
    options: {
      image: "test",
      organization: "planner-executor",
      budget: { executions: 12 },
    },
  };
  expect(await adapter.preflight(config)).toMatchObject({
    role: "planner-executor",
    native_budget: { executions: 12 },
    role_prompts: {
      planner: { version: "eda-planner-v2" },
      executor: { version: "eda-executor-v2" },
    },
    trajectory_mapping: "planner-executor-v1",
  });
  let captured: unknown;
  await expect(
    statigentAdapter({
      run: async (options) => {
        captured = options.task;
        throw new Error("captured");
      },
    }).run({
      ...invocation("/tmp"),
      config,
      budget: { timeout_ms: 5000, total_tokens: 80000, model_attempts: 2 },
    }),
  ).rejects.toThrow("captured");
  expect(captured).toMatchObject({
    organization: "planner-executor",
    budget: {
      executions: 12,
      total_tokens: 80000,
      model_attempts: 2,
      task_timeout_ms: 5000,
    },
  });
});

test("v3 adapter delivers text and planner report, counts role costs once and maps every cell once", async () => {
  for (const report of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "evaluation-collaboration-"));
    try {
      await writeFile(join(root, "data.csv"), "value\n1\n2\n");
      await mkdir(join(root, "deliverables"));
      const i = invocation(root);
      i.config.options = {
        ...i.config.options,
        organization: "planner-executor",
        budget: { executions: 12 },
      };
      i.budget.model_attempts = 8;
      i.trajectory = true;
      if (report)
        i.task = {
          ...i.task,
          output: {
            kind: "report",
            instructions: "Plot means",
            report_file: "report.md",
            image_types: ["png"],
            max_images: 2,
            max_image_bytes: 4096,
            max_report_bytes: 4096,
          },
        };
      const runtime = fakeRuntime();
      let imageRef = "";
      const s = await statigentAdapter({
        overrides: {
          client: new ScriptClient((b, n) => {
            if (report && n === 6) {
              const feedback = lastFeedback(b);
              const images = feedback.images as { reference: string }[];
              imageRef = String(images[0]?.reference);
              const refs =
                (feedback.findings as { evidence_refs: string[] }[])[0]
                  ?.evidence_refs ?? [];
              const args = JSON.parse(
                finish(String(refs[0])).function.arguments,
              );
              return reply([
                call("finish_analysis", {
                  ...args,
                  report_markdown: `# Report\n![means](${imageRef})`,
                }),
              ]);
            }
            if (report && (n === 2 || n === 5)) {
              const f = lastFeedback(b);
              return reply([
                returned(b, [
                  String(f.cell_id),
                  String(
                    (f.artifacts as { artifact_id: string }[])[0]?.artifact_id,
                  ),
                ]),
              ]);
            }
            return twoSubtasks(b, n);
          }),
          createSession: async (c, r) => {
            const session = await runtime.createSession(c, r);
            return {
              ...session,
              execute: async (code, opts) => {
                const result = await session.execute(code, opts);
                if (!report) return result;
                const artifact = await r.onArtifact({
                  path: "means.png",
                  mime_type: "image/png",
                  data_base64: png(1, 1).toString("base64"),
                  cell_id: result.cell_id,
                });
                return { ...result, artifacts: [artifact] };
              },
            };
          },
          export: (dir, _, status) =>
            exportNotebooks(dir, async () => {}, status),
        },
      }).run(i);
      expect(s.status, s.reason).toBe("completed");
      expect(s.answer_text).toBeTruthy();
      expect(s.usage).toMatchObject({
        attempts: 7,
        total_tokens: 105,
        source: "measured",
      });
      const m = await readManifest(s.native_run?.directory ?? "");
      expect(m.schema_version).toBe(3);
      expect(
        m.agent === "not_applicable" ? null : m.agent?.budget.executions,
      ).toBe(12);
      const trajectory = await Bun.file(
        join(root, "deliverables/trajectory.txt"),
      ).text();
      expect(trajectory).toContain("planner-executor-v1");
      expect(trajectory.match(/secret_state=2/g)).toHaveLength(1);
      expect(trajectory.match(/print\(secret_state\)/g)).toHaveLength(1);
      expect(trajectory.match(/Role: executor; subtask:/g)).toHaveLength(2);
      if (report) {
        expect(
          await Bun.file(join(root, "deliverables/report.md")).text(),
        ).toBe(`# Report\n![means](${imageRef})`);
        expect(
          await Bun.file(join(root, "deliverables", imageRef)).exists(),
        ).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
