import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { prepareDataset } from "../../src/modeling/data";
import { reproduce, scoreDelivery } from "../../src/modeling/delivery";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { obj } from "../../src/models/validation";
import { sha256 } from "../../src/records/store";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { modelingEdaScript, modelingScript } from "../helpers/modeling";

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      const p = join(e.parentPath, e.name);
      out[p] = sha256(await readFile(p));
    }
  return out;
}
test("modeling delegates real EDA, links evidence, finalizes and reproduces frozen predictions", async () => {
  const root = resolve("runs/integration-modeling-loop", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  const client = new ScriptClient(modelingScript()),
    edaClient = new ScriptClient(modelingEdaScript());
  const result = await runModeling({
    task: {
      goal: "Test synthetic loop",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      eda_profile: profile.id,
      image: "statigent-runtime:dev",
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
    edaClient,
  });
  expect(result.status, result.reason).toBe("completed");
  const view = await inspectModeling(result.directory);
  expect(view.unconfirmed_children).toHaveLength(0);
  expect(
    view.events.filter((e) => e.type === "experiment_result"),
  ).toHaveLength(3);
  expect(view.events.filter((e) => e.type === "child_intent")).toHaveLength(7);
  const json = JSON.stringify(client.bodies);
  expect(json).not.toContain("pd.read_csv");
  expect(json).not.toContain("/input/validation.csv");
  const before = await snapshot(result.directory);
  expect(
    (await reproduce(result.directory, join(root, "reproductions"))).status,
  ).toBe("passed");
  expect(
    (await reproduce(result.directory, join(root, "refits"), "refit")).status,
  ).toBe("passed");
  const labels = join(root, "private");
  await mkdir(labels);
  await writeFile(join(labels, "labels.csv"), "id,target\n13,26\n14,28\n");
  expect(
    (
      await scoreDelivery(
        result.directory,
        labels,
        "labels.csv",
        join(root, "scores"),
      )
    ).value,
  ).toBeLessThan(1e-8);
  expect(await snapshot(result.directory)).toEqual(before);
  const datasetPath = join(root, "data", "dataset.json");
  const original = await readFile(datasetPath, "utf8");
  const changed = JSON.parse(original);
  changed.seed++;
  await writeFile(datasetPath, JSON.stringify(changed));
  await expect(
    reproduce(result.directory, join(root, "mismatch")),
  ).rejects.toThrow("Frozen input identity mismatch");
  await writeFile(datasetPath, original);
  await writeFile(join(labels, "bad.csv"), "id,target\n13,26\n15,28\n");
  await expect(
    scoreDelivery(result.directory, labels, "bad.csv", join(root, "scores")),
  ).rejects.toThrow("membership");
  console.log(JSON.stringify({ kind: "modeling_integration", ...result }));
}, 240000);

test("two EDA calls get independent kernels and only explicitly published prediction snapshots", async () => {
  const root = resolve("runs/integration-modeling-loop", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  const base = modelingScript(),
    eda = modelingEdaScript();
  const client = new ScriptClient((body, i) => {
    if (i === 2) {
      const previous = obj(lastFeedback(body).result);
      return reply([
        call("analyze", {
          candidates: [
            {
              id: "linear",
              change: "Investigate x again independently",
              priority: 1,
            },
          ],
          question: "Check residual relation to x",
          expected_evidence: "Explicit residual comparison",
          decision_rules: "Test linear if relation exists",
          source_experiment: previous.source_experiment,
        }),
      ]);
    }
    return base(body, i > 2 ? i - 1 : i);
  });
  const result = await runModeling({
    task: {
      goal: "Two independent analyses",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
      budget: { eda_calls: 2, eda_executions: 20 },
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
    edaClient: new ScriptClient((body, i) => eda(body, i % 4)),
  });
  expect(result.status, result.reason).toBe("completed");
  const { manifest } = await inspectModeling(result.directory);
  const analyses = manifest.analyses;
  if (!Array.isArray(analyses)) throw Error("missing analyses");
  expect(analyses).toHaveLength(2);
  expect(obj(analyses[0]).run_id).not.toBe(obj(analyses[1]).run_id);
}, 180000);
