import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { MODELING_METHODS } from "../../src/modeling/config";
import { datasetProtocol, prepareDataset } from "../../src/modeling/data";
import { runModeling } from "../../src/modeling/run";
import { emptyLedger } from "../../src/records/agent-metadata";
import { profile, ScriptClient } from "../helpers/agent";

async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "model-start-"));
  await prepareDataset(source, join(root, "data"));
  const task = {
    schema_version: 3,
    method: "collaborative",
    resource_version: "smoke-v1",
    confirmation: { mode: "none" },
    goal: "predict",
    dataset_root: join(root, "data"),
    model_profile: profile.id,
    image: "test",
  };
  return { root, task };
}
test("four methods receive identical basic statistics before their first decision with recorded preparation cost", async () => {
  const f = await setup();
  const views = [];
  for (const method of MODELING_METHODS) {
    const controller = new AbortController();
    const client = new ScriptClient(() => {
      controller.abort();
      throw new Error("end startup probe");
    });
    const result = await runModeling({
      task: { ...f.task, method },
      profile,
      edaProfile: profile,
      runRoot: f.root,
      client,
      signal: controller.signal,
      analysis: async (o) => ({
        id: o.id,
        run_id: o.runId,
        directory: null,
        dispatch: "not_started",
        execution_confirmed: true,
        status: "failed",
        reason: "synthetic initial failure",
        source_experiment: null,
        dataset_hash: o.dataset.files[0]?.sha256 ?? "",
        split_hash: o.dataset.split.sha256,
        protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
        prediction_sha256: null,
        analysis: null,
        effective_budget: o.budget,
        deadline: o.deadline,
        cost: emptyLedger(),
        role_usage: { planner: emptyLedger(), executor: emptyLedger() },
        executions: 0,
        request: o.request,
      }),
    });
    expect(client.bodies).toHaveLength(1);
    const messages = client.bodies[0]?.messages as { content: string }[];
    const visible = JSON.parse(
      messages.find((m) => m.content.includes('"basic_profile"'))?.content ??
        "{}",
    );
    // Citation syntax belongs to the collaborative interface; the underlying
    // statistics and their identity must remain identical in every method.
    views.push(
      JSON.stringify({
        basic_profile: visible.basic_profile,
        basic_profile_sha256: visible.basic_profile_sha256,
      }),
    );
    expect(visible.profile_source_examples).toEqual([
      "profile:/rows",
      "profile:/columns",
    ]);
    const manifest = JSON.parse(
      await readFile(join(result.directory, "modeling.json"), "utf8"),
    );
    expect(manifest.preparation.profile_elapsed_ms).toBeGreaterThan(0);
    expect(manifest.basic_profile.artifact.sha256).toBeString();
    expect(manifest.experiments).toEqual([]);
  }
  expect(new Set(views).size).toBe(1);
  expect(views[0]).toBeString();
}, 30000);

test("failed preparation is recorded and never enters model search", async () => {
  const f = await setup();
  const client = new ScriptClient(() => {
    throw new Error("must not call");
  });
  const result = await runModeling({
    task: f.task,
    profile,
    edaProfile: profile,
    runRoot: f.root,
    client,
    prepareProfile: async () => {
      throw new Error("profile_failure:invalid data");
    },
  });
  expect(result.status).toBe("failed");
  expect(result.reason).toContain("profile_failure");
  expect(client.bodies).toHaveLength(0);
  const manifest = JSON.parse(
    await readFile(join(result.directory, "modeling.json"), "utf8"),
  );
  expect(manifest.basic_profile).toBeNull();
  expect(manifest.experiments).toEqual([]);
  expect(manifest.preparation.profile_elapsed_ms).toBeGreaterThanOrEqual(0);
});
