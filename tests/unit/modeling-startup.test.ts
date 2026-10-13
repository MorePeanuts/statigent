import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { MODELING_METHODS } from "../../src/modeling/config";
import { prepareDataset } from "../../src/modeling/data";
import { runModeling } from "../../src/modeling/run";
import { profile, ScriptClient } from "../helpers/agent";

async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "model-start-"));
  await prepareDataset(source, join(root, "data"));
  const task = {
    schema_version: 2,
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
    });
    expect(client.bodies).toHaveLength(1);
    const messages = client.bodies[0]?.messages as { content: string }[];
    views.push(
      messages.find((m) => m.content.includes('"basic_profile"'))?.content,
    );
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
