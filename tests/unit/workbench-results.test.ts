import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeJson } from "../../src/records/store";
import { resultSummary } from "../../src/workbench/results";
import type { RunSource } from "../../src/workbench/runs";
import type { SupervisorRecord } from "../../src/workbench/supervisor";
import { call, reply, ScriptClient } from "../helpers/agent";
import { agentRun } from "../helpers/workbench";

async function source(): Promise<RunSource> {
  const root = await mkdtemp(join(tmpdir(), "workbench-results-"));
  return {
    runsRoot: join(root, "runs"),
    recordsRoot: join(root, "supervisor"),
    isLive: () => false,
    current: () => null,
  };
}

test("a completed run presents its accepted analysis with resolved evidence", async () => {
  const s = await source();
  await agentRun(s.runsRoot, "done");
  const result = await resultSummary(s, "done");
  expect(result).toMatchObject({
    status: { status: "completed", cancellable: false },
    termination: "analysis_accepted",
    complete: true,
    notice: null,
    report: null,
    export: { status: "exported" },
    replay: { eligible: true },
    cost: { model_attempts: 2, executions: 1, tokens_known: true },
  });
  expect(result.analysis?.findings[0]).toMatchObject({
    statement: "分组均值",
    value: { group_means: { A: 2, B: 4 } },
    evidence: [
      {
        ref: "cell-1",
        kind: "execution",
        execution_seq: 1,
        execution_status: "ok",
        role: null,
      },
    ],
  });
  expect(result.files.map((f) => [f.kind, f.available])).toEqual([
    ["analysis_json", true],
    ["analysis_markdown", true],
    ["notebook", true],
  ]);
  // Input identities come from the execution session; the stand-in records none.
  expect(result.inputs).toEqual(
    (await readManifest(join(s.runsRoot, "done"))).inputs,
  );
  expect(result.cost.total_tokens).toBeGreaterThan(0);
});

test("a run that ran out of budget is shown without an accepted result", async () => {
  const s = await source();
  await agentRun(s.runsRoot, "exhausted", {
    budget: { model_attempts: 1 },
    client: new ScriptClient(() =>
      reply([call("execute_python", { code: "x = 1" })]),
    ),
  });
  const result = await resultSummary(s, "exhausted");
  expect(result.status.status).toBe("budget_exhausted");
  expect(result).toMatchObject({ complete: false, analysis: null });
  expect(result.notice).toStartWith(
    "No accepted final result: the run ended as budget_exhausted",
  );
  // Partial work stays reachable.
  expect(result.files.find((f) => f.kind === "notebook")?.available).toBe(true);
});

test("a failed run names its termination reason", async () => {
  const s = await source();
  // Plain text instead of a tool call, every time: the correction quota runs out.
  await agentRun(s.runsRoot, "failed", {
    client: new ScriptClient(() => reply()),
  });
  const result = await resultSummary(s, "failed");
  expect(result).toMatchObject({
    status: { status: "failed" },
    termination: "action_corrections_exhausted",
    complete: false,
    analysis: null,
  });
  expect(result.notice).toContain("action_corrections_exhausted");
});

test("report images map to registered artifacts and artifact evidence resolves", async () => {
  const s = await source();
  await agentRun(s.runsRoot, "report");
  const directory = join(s.runsRoot, "report");
  const png = Buffer.from("not really a png, only registered");
  const id = randomUUID();
  await writeFile(join(directory, "artifacts", id), png);
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  manifest.artifacts.push({
    artifact_id: id,
    path: `artifacts/${id}`,
    mime_type: "image/png",
    size_bytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
    complete: true,
    source_path: "figures/means.png",
  });
  await writeJson(join(directory, "manifest.json"), manifest);
  const analysis = JSON.parse(
    await readFile(join(directory, "analysis.json"), "utf8"),
  );
  analysis.findings.push({
    statement: "Chart",
    evidence_refs: [id, "nowhere"],
  });
  analysis.report = {
    artifact_id: id,
    source_path: "report.md",
    images: [
      {
        reference: "figures/means.png",
        path: "figures/means.png",
        artifact_id: id,
      },
    ],
  };
  await writeJson(join(directory, "analysis.json"), analysis);
  const result = await resultSummary(s, "report");
  expect(result.report?.images).toEqual([
    {
      reference: "figures/means.png",
      path: "figures/means.png",
      artifact_id: id,
    },
  ]);
  expect(result.analysis?.findings.at(-1)?.evidence).toMatchObject([
    {
      kind: "artifact",
      artifact: {
        artifact_id: id,
        mime_type: "image/png",
        source_path: "figures/means.png",
      },
    },
    { ref: "nowhere", kind: "unknown", artifact: null },
  ]);
});

test("a worker that died before creating its record still gets a summary", async () => {
  const s = await source();
  const record: SupervisorRecord = {
    run_id: "nostart",
    agent_type: "eda",
    profile: "deepseek-flash",
    backend: "persistent-kernel",
    image: "statigent-runtime:dev",
    task_path: "/nonexistent",
    pid: 1,
    started_at: "2026-10-20T00:00:00Z",
    ended_at: "2026-10-20T00:00:01Z",
    exit_code: 1,
    exit_signal: null,
    summary: null,
    stderr_tail: "Invalid model configuration",
    cancel_requested_at: null,
    forced_kill: null,
  };
  await Bun.write(join(s.recordsRoot, "nostart.json"), JSON.stringify(record));
  const result = await resultSummary(s, "nostart");
  expect(result).toMatchObject({
    status: { status: "failed" },
    complete: false,
    analysis: null,
    files: [],
    export: { status: "not_available" },
    replay: null,
  });
  expect(result.status.detail).toContain("Invalid model configuration");
});

test("unknown runs are a 404", async () => {
  const s = await source();
  expect(resultSummary(s, "missing")).rejects.toMatchObject({ status: 404 });
});
