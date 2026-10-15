import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildPlan } from "../../src/evaluation/plan";
import { inspect } from "../../src/evaluation/records";
import { rescore } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { sha256 } from "../../src/records/store";
import { config, fixtureRegistry, task } from "../helpers/evaluation";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const usage = {
  source: "not_applicable",
  attempts: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  unknown_attempts: 0,
  currency_cost: "not_computed",
};
/** Writes a batch exactly as the v1 harness laid it out (inline artifacts, no deliverables). */
async function v1Batch(root: string): Promise<string> {
  const v1Task = { ...task, schema_version: 1 };
  const body = {
    schema_version: 1,
    config: config(),
    tasks: [v1Task, { ...v1Task, id: "two" }],
    units: ["one", "two"].map((t, i) => ({
      id: `unit-00000${i + 1}`,
      task_id: t,
      agent_id: "a",
      repetition: 0,
      seed: 42,
    })),
    source_root: root,
    provenance: { version: "v1" },
    adapters: { "benchmark:synthetic": "1", "agent:fixture": "1" },
  };
  const plan = { ...body, sha256: sha256(Buffer.from(JSON.stringify(body))) };
  const evaluationId = "11111111-2222-3333-4444-555555555555";
  const directory = join(root, "runs", evaluationId);
  for (const sub of ["scores", "native"])
    await mkdir(join(directory, sub), { recursive: true });
  await writeFile(join(directory, "plan.json"), JSON.stringify(plan));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      evaluation_id: evaluationId,
      created_at: "2026-10-12T00:00:00.000Z",
      completed_at: "2026-10-12T00:00:01.000Z",
      plan_sha256: plan.sha256,
      status: "completed",
      reason: "",
      environment: {},
      preflight: {},
    }),
  );
  for (const [i, unit] of body.units.entries()) {
    const dir = join(directory, "units", unit.id);
    await mkdir(join(dir, "artifacts"), { recursive: true });
    const answer = i === 0 ? "@sum[3]" : "@sum[4]";
    const submission = JSON.stringify({
      schema_version: 1,
      unit_id: unit.id,
      status: "completed",
      answer_text: answer,
      reason: "done",
      artifacts: [{ name: "result.txt", base64: "Mw==" }],
      native_run: null,
      usage,
      cleanup_error: null,
      record_error: false,
    });
    await writeFile(join(dir, "submission.json"), submission, { mode: 0o400 });
    await writeFile(join(dir, "artifacts", "result.txt"), "3", { mode: 0o400 });
    await writeFile(
      join(dir, "record.json"),
      JSON.stringify({
        unit,
        execution_status: "completed",
        reason: "done",
        started_at: "now",
        ended_at: "now",
        elapsed_ms: 1,
        scoring_elapsed_ms: 1,
        effective_budget: config().task_budget,
        budget_status: "within",
        submission_sha256: sha256(Buffer.from(submission)),
        scoring_status: "scored",
        score: {
          schema_version: 1,
          unit_id: unit.id,
          protocol: "exact-v1",
          status: "scored",
          metrics: [
            {
              name: "accuracy",
              value: i === 0 ? 1 : 0,
              minimum: 0,
              maximum: 1,
              direction: "higher",
            },
          ],
          details: {},
          error: null,
        },
      }),
    );
  }
  return directory;
}
async function hashes(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else
        out[relative(directory, path)] = sha256(await Bun.file(path).bytes());
    }
  };
  await visit(directory);
  return out;
}
test("v1 batches stay inspectable and rescore to the same metrics without rewriting files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "v1-batch-")));
  roots.push(root);
  await writeFile(join(root, "data.csv"), "value\n1\n2\n");
  const directory = await v1Batch(root);
  const before = await hashes(directory);
  const view = await inspect(directory);
  expect(view.manifest.status).toBe("completed");
  expect(view.plan.tasks.map((t) => t.schema_version)).toEqual([2, 2]);
  expect(
    view.records.map((r) => [
      r.execution_status,
      r.scoring_status,
      r.score?.metrics[0]?.value,
      r.score?.judge,
    ]),
  ).toEqual([
    ["completed", "scored", 1, null],
    ["completed", "scored", 0, null],
  ]);
  const result = await rescore(directory, fixtureRegistry(root));
  expect(result.report.scores.map((s) => s.score?.metrics[0]?.value)).toEqual([
    1, 0,
  ]);
  expect(result.report.groups[0]?.metrics).toEqual({ accuracy: 0.5 });
  const after = await hashes(directory);
  for (const [path, hash] of Object.entries(before))
    expect(after[path]).toBe(hash);
  // Tampering with a legacy artifact is still detected.
  const artifact = join(directory, "units/unit-000001/artifacts/result.txt");
  await chmod(artifact, 0o600);
  await writeFile(artifact, "4");
  await expect(inspect(directory)).rejects.toThrow("integrity");
});

for (const version of [2, 3] as const) {
  test(`historical v${version} batch remains immutable through inspection and offline rescoring`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "legacy-batch-")));
    roots.push(root);
    await writeFile(join(root, "data.csv"), "value\n1\n2\n");
    const registry = fixtureRegistry(root);
    const plan = await buildPlan(config(), registry);
    const run = await runEvaluation(plan, registry, join(root, "runs"), {
      environment: { synthetic: true },
    });
    // 固定旧计划的真实字段集合；旧 v3 不具有新增的 baseline 来源快照。
    const { sha256: _checksum, ...body } = plan;
    const legacyBody = { ...body, schema_version: version };
    const checksum = sha256(Buffer.from(JSON.stringify(legacyBody)));
    const planPath = join(run.directory, "plan.json");
    const manifestPath = join(run.directory, "manifest.json");
    const manifest = await Bun.file(manifestPath).json();
    await writeFile(
      planPath,
      JSON.stringify({ ...legacyBody, sha256: checksum }),
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        schema_version: version,
        plan_sha256: checksum,
      }),
    );
    const before = await hashes(run.directory);
    const view = await inspect(run.directory);
    expect(view.plan.schema_version).toBe(version);
    expect(view.plan.baseline_methods).toBeUndefined();
    const rescored = await rescore(run.directory, registry);
    expect(rescored.report.scores.map((s) => s.score?.metrics)).toEqual(
      view.records.map((r) => r.score?.metrics),
    );
    const after = await hashes(run.directory);
    for (const [path, hash] of Object.entries(before))
      expect(after[path]).toBe(hash);
  });
}
