import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, tools } from "../../src/agent/actions";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../../src/agent/prompt";
import { runAgent } from "../../src/agent/run";
import { executionId } from "../../src/execution/script-protocol";
import { exportNotebooks } from "../../src/records/notebook";
import { readManifest, sha256 } from "../../src/records/store";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  ScriptClient,
  task,
} from "../helpers/agent";
import { png } from "../helpers/images";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const spec = {
  image_types: ["png", "jpeg"],
  max_images: 3,
  max_image_bytes: 4096,
  max_report_bytes: 4096,
};
/** Fake runtime where `FILES:{...}` code saves workspace files as artifacts, like the real bridge. */
function workspaceRuntime() {
  const base = fakeRuntime();
  const createSession: typeof base.createSession = async (config, recorder) => {
    const session = await base.createSession(config, recorder);
    return {
      ...session,
      async execute(code, options) {
        const result = await session.execute(code, options);
        if (!code.startsWith("FILES:")) return result;
        const files = JSON.parse(code.slice(6)) as Record<string, string>;
        const artifacts = [];
        for (const [path, base64] of Object.entries(files)) {
          const data = Buffer.from(base64, "base64");
          const ref = await recorder.onArtifact({
            path,
            data_base64: base64,
            size_bytes: data.length,
            mime_type: path.endsWith(".md") ? "text/markdown" : "image/png",
            complete: true,
            cell_id: executionId(result),
          });
          artifacts.push({ ...ref, path: ref.path });
        }
        return { ...result, artifacts };
      },
    };
  };
  return { ...base, createSession };
}
const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
async function run(
  steps: ((feedback: Record<string, unknown> | null) => unknown)[],
  report: typeof spec | null = spec,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-report-")));
  roots.push(root);
  await writeFile(join(root, "synthetic.csv"), "group,value\nA,2\nB,4\n");
  const client = new ScriptClient((body, n) => {
    const feedback = n === 0 ? null : lastFeedback(body);
    const step = steps[n];
    if (!step) throw new Error("script exhausted");
    return step(feedback);
  });
  const result = await runAgent({
    task: {
      ...task,
      ...(report ? { report } : {}),
      execution: { ...task.execution, input_root: root },
    },
    profile: client.profile,
    runRoot: join(root, "runs"),
    client,
    createSession: workspaceRuntime().createSession,
    export: (dir, _, status) => exportNotebooks(dir, async () => {}, status),
  });
  return { result, client, root };
}
const artifactOf = (feedback: Record<string, unknown> | null, mime: string) =>
  String(
    (feedback?.artifacts as { artifact_id: string; mime_type: string }[]).find(
      (a) => a.mime_type === mime,
    )?.artifact_id,
  );
function finishReport(feedback: Record<string, unknown> | null, id?: string) {
  const action = finish(String(feedback?.cell_id));
  const args = JSON.parse(action.function.arguments);
  args.report_artifact_id = id ?? artifactOf(feedback, "text/markdown");
  return {
    ...action,
    function: { ...action.function, arguments: JSON.stringify(args) },
  };
}
const save = (files: Record<string, string>) =>
  reply1(call("execute_python", { code: `FILES:${JSON.stringify(files)}` }));
function reply1(c: unknown) {
  return {
    id: crypto.randomUUID(),
    model: "fake-v1",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "r",
          tool_calls: [c],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}
test("report tasks finish only with a saved Markdown report whose images were saved in this run", async () => {
  const { result, client } = await run([
    () =>
      save({
        "out/report.md": b64(
          "# Sales\n![trend](./chart.png)\n![trend](chart.png)",
        ),
        "out/chart.png": b64(png(4, 4)),
        "out/unused.png": b64(png(1, 1)),
      }),
    (f) => reply1(finishReport(f)),
  ]);
  expect(result.status).toBe("completed");
  expect(result.analysis?.report).toMatchObject({
    source_path: "out/report.md",
    images: [{ reference: "chart.png", path: "out/chart.png" }],
  });
  const finishTool = (
    client.bodies[0]?.tools as {
      function: { name: string; parameters: { required: string[] } };
    }[]
  ).find((t) => t.function.name === "finish_analysis");
  expect(finishTool?.function.parameters.required).toContain(
    "report_artifact_id",
  );
  const constraints = JSON.parse(
    (client.bodies[0]?.messages as { content: string }[])[1]?.content ?? "{}",
  ).constraints as string[];
  expect(constraints.some((c) => c.includes("report_artifact_id"))).toBe(true);
  const manifest = await readManifest(result.directory);
  expect(manifest.prompt).toEqual({
    version: `${PROMPT_VERSION}+report-v1`,
    sha256: sha256(Buffer.from(SYSTEM_PROMPT)),
  });
});
test("invalid reports are rejected as corrections and the model can repair them", async () => {
  for (const [files, message] of [
    [{ "report.md": b64("![x](missing.png)") }, "not saved"],
    [{ "report.md": b64("![x](https://example.com/a.png)") }, "relative"],
    [{ "report.md": b64("![x](../a.png)"), "a.png": b64(png(1, 1)) }, "Unsafe"],
    [
      { "report.md": b64("![x](a.png)"), "a.png": b64("not an image") },
      "png/jpeg",
    ],
    [{ "notes.txt": b64("no report") }, "Markdown"],
  ] as const) {
    const { result, client } = await run([
      () => save({ ...files }),
      (f) =>
        reply1(
          finishReport(
            f,
            artifactOf(
              f,
              Object.keys(files)[0]?.endsWith(".md")
                ? "text/markdown"
                : "image/png",
            ),
          ),
        ),
      (f) => {
        expect(String(f?.diagnostic)).toContain(message);
        return save({ "final.md": b64("# Final\nNo charts.") });
      },
      (f) => reply1(finishReport(f)),
    ]);
    expect(result.status).toBe("completed");
    expect(result.analysis?.report?.source_path).toBe("final.md");
    expect(client.bodies).toHaveLength(4);
  }
  // A finish without report_artifact_id is an invalid action for a report task.
  // Rejections carry no cell id, so later attempts keep citing the first executed cell.
  let cell = "";
  const missing = await run([
    () => save({ "report.md": b64("# r") }),
    (f) => {
      cell = String(f?.cell_id);
      return reply1(finish(cell));
    },
    (f) => {
      expect(String(f?.diagnostic)).toContain("report_artifact_id");
      return reply1(finishReport({ cell_id: cell }, "nope"));
    },
    (f) => {
      expect(String(f?.diagnostic)).toContain("not a saved file");
      return reply1(finishReport({ cell_id: cell }, "nope"));
    },
  ]);
  expect(missing.result).toMatchObject({
    status: "failed",
    reason: "action_corrections_exhausted",
  });
});
test("text tasks keep the original tool schema, prompt version and prompt hash", async () => {
  expect(tools(false)).toBe(TOOLS);
  const { result, client } = await run(
    [
      () => reply1(call("execute_python", { code: "print(1)" })),
      (f) => reply1(finish(String(f?.cell_id))),
    ],
    null,
  );
  expect(result.status).toBe("completed");
  expect(JSON.stringify(client.bodies[0]?.tools)).toBe(JSON.stringify(TOOLS));
  expect(JSON.stringify(client.bodies[0])).not.toContain("report_artifact_id");
  expect((await readManifest(result.directory)).prompt).toEqual({
    version: PROMPT_VERSION,
    sha256: sha256(Buffer.from(SYSTEM_PROMPT)),
  });
});
test("documented report task example runs and produces the documented analysis.report shape", async () => {
  const example = await Bun.file("configs/tasks/synthetic-report.json").json();
  const doc = await Bun.file("docs/agent.md").text();
  const block = /```json\n([\s\S]*?)```/.exec(
    doc.slice(doc.indexOf("## 报告输出")),
  )?.[1];
  if (!block) throw new Error("Missing documented analysis.report");
  const documented = JSON.parse(block).report;
  const root = await realpath(await mkdtemp(join(tmpdir(), "report-doc-")));
  roots.push(root);
  const client = new ScriptClient((body, n) =>
    n === 0
      ? save({
          "report.md": b64("# Groups\n![Means](./chart.png)"),
          "chart.png": b64(png(2, 2)),
        })
      : reply1(finishReport(lastFeedback(body))),
  );
  const result = await runAgent({
    task: example,
    profile: client.profile,
    runRoot: join(root, "runs"),
    client,
    createSession: workspaceRuntime().createSession,
    export: (dir, _, status) => exportNotebooks(dir, async () => {}, status),
  });
  expect(result.status, result.reason).toBe("completed");
  const saved = await Bun.file(join(result.directory, "analysis.json")).json();
  expect(Object.keys(saved.report).sort()).toEqual(
    Object.keys(documented).sort(),
  );
  expect(Object.keys(saved.report.images[0]).sort()).toEqual(
    Object.keys(documented.images[0]).sort(),
  );
  expect(saved.report.images[0]).toMatchObject({
    reference: "chart.png",
    path: "chart.png",
  });
});
