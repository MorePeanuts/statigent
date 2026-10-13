import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import multiclass from "../../configs/modeling/multiclass-prepare.json";
import { dockerCommand } from "../../src/execution/docker";
import { validateModelingTask } from "../../src/modeling/config";
import { loadDataset, prepareDataset } from "../../src/modeling/data";
import { reproduce, scoreDelivery } from "../../src/modeling/delivery";
import { runExperiment } from "../../src/modeling/experiments";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { scoreTables } from "../../src/modeling/scoring";
import { validateSmoke } from "../../src/modeling/smoke";
import { obj } from "../../src/models/validation";
import { readManifest, sha256 } from "../../src/records/store";
import { profile, ScriptClient } from "../helpers/agent";
import {
  classificationEdaScript,
  classificationScript,
  classifierTree,
} from "../helpers/classification";

async function snapshot(root: string) {
  const out: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      const p = join(e.parentPath, e.name);
      out[p] = sha256(await readFile(p));
    }
  return out;
}
for (const source of [binary, multiclass]) {
  test(`${source.kind} real isolated pipeline: search, dual-role EDA, evidence, delivery, predict/refit and score`, async () => {
    const root = resolve("runs/integration-classification", randomUUID());
    await mkdir(root, { recursive: true });
    await prepareDataset(source, join(root, "data"));
    const inputs = await snapshot(join(root, "data"));
    const client = new ScriptClient(classificationScript()),
      edaClient = new ScriptClient(classificationEdaScript());
    const r = await runModeling({
      task: {
        schema_version: 2,
        method: "adaptive_eda",
        confirmation: { mode: "none" },
        resource_version: "smoke-v1",

        goal: "synthetic classification",
        dataset_root: join(root, "data"),
        model_profile: profile.id,
        image: "statigent-runtime:dev",
      },
      profile,
      edaProfile: profile,
      runRoot: root,
      client,
      edaClient,
    });
    expect(r.status, r.reason).toBe("completed");
    const view = await inspectModeling(r.directory);
    expect(await validateSmoke(r.directory)).toMatchObject({
      source_experiment: expect.any(String),
    });
    expect(view.manifest.schema_version).toBe(3);
    const experiments = (view.manifest.experiments as unknown[]).map(obj);
    expect(experiments).toHaveLength(3);
    expect(r.best_experiment_id).toBe(String(experiments[1]?.id));
    expect(experiments[2]?.score).toBeNull();
    expect(view.manifest.usage).toMatchObject({
      tokens: { attempts: 8, total_tokens: 120 },
      eda_calls: 1,
      training_attempts: 3,
    });
    const before = await snapshot(r.directory);
    expect((await reproduce(r.directory, join(root, "replays"))).status).toBe(
      "passed",
    );
    expect(
      (await reproduce(r.directory, join(root, "refits"), "refit")).status,
    ).toBe("passed");
    const privateRoot = join(root, "private");
    await mkdir(privateRoot);
    await writeFile(
      join(privateRoot, "labels.csv"),
      "id,target\n" +
        ["100", "101", "102", "103", "104", "105"]
          .map(
            (id, i) =>
              `${id},${source.kind === "binary" ? (i % 2 ? "1" : "01") : i % 2 ? "blue" : "NA"}`,
          )
          .join("\n") +
        "\n",
    );
    const score = await scoreDelivery(
      r.directory,
      privateRoot,
      "labels.csv",
      join(root, "scores"),
    );
    expect(score).toMatchObject({
      status: "completed",
      score: { metric: source.metric },
    });
    expect(score.score?.value).toBeCloseTo(source.kind === "binary" ? 1 : 0, 8);
    await writeFile(join(privateRoot, "bad.csv"), "id,target\n100,unknown\n");
    expect(
      await scoreDelivery(
        r.directory,
        privateRoot,
        "bad.csv",
        join(root, "scores"),
      ),
    ).toMatchObject({ status: "failed", score: null });
    expect(await snapshot(r.directory)).toEqual(before);
    expect(await snapshot(join(root, "data"))).toEqual(inputs);
    for (const e of experiments)
      for (const name of ["fit", "predict"]) {
        const stage = obj(e[name]);
        const manifest = await readManifest(String(stage.directory));
        expect(manifest.inputs.map((f) => f.path)).not.toContain("labels.csv");
        expect(
          await dockerCommand([
            "ps",
            "-aq",
            "--filter",
            `label=org.statigent.run=${stage.run_id}`,
          ]),
        ).toBe("");
      }
  }, 240000);
  test(`${source.kind} accuracy uses decoded label-only artifacts with model metadata`, async () => {
    const root = resolve("runs/integration-classification", randomUUID());
    await mkdir(root, { recursive: true });
    await prepareDataset({ ...source, metric: "accuracy" }, join(root, "data"));
    const task = validateModelingTask({
      schema_version: 2,
      method: "adaptive_eda",
      confirmation: { mode: "none" },
      resource_version: "smoke-v1",

      goal: "accuracy",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
    });
    const e = await runExperiment({
      root,
      task,
      ...(await loadDataset(task.dataset_root)),
      candidateId: "tree",
      code: classifierTree,
      signal: new AbortController().signal,
      remaining: () => 90000,
    });
    expect(e.status, e.reason).toBe("completed");
    expect(e.score?.value).toBe(1);
    expect(e.fit?.metadata?.sha256).toHaveLength(64);
  }, 120000);
}

test("illegal probabilities fail before scoring or evidence; scoring timeout and parent cancellation stop dispatch", async () => {
  const root = resolve("runs/integration-classification-failure", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(binary, join(root, "data"));
  const task = validateModelingTask({
    schema_version: 2,
    method: "adaptive_eda",
    confirmation: { mode: "none" },
    resource_version: "smoke-v1",

    goal: "failure boundary",
    dataset_root: join(root, "data"),
    model_profile: profile.id,
    image: "statigent-runtime:dev",
  });
  const invalid = await runExperiment({
    root,
    task,
    ...(await loadDataset(task.dataset_root)),
    candidateId: "bad",
    signal: new AbortController().signal,
    remaining: () => 90000,
    code: "import numpy as np\nfrom sklearn.dummy import DummyClassifier\nclass Bad(DummyClassifier):\n    def predict_proba(self,X): return np.tile([-0.1,1.1],(len(X),1))\ndef build_pipeline(seed): return Bad()\n",
    score: async () => {
      throw Error("Invalid probabilities reached scorer");
    },
  });
  expect(invalid.status).toBe("failed");
  expect(invalid.score).toBeNull();
  expect(invalid.reason).toContain("probability");
  for (const mode of ["timeout", "cancel"]) {
    const controller = new AbortController(),
      client = new ScriptClient(classificationScript());
    let dispatched = 0;
    const result = await runModeling({
      task,
      profile,
      edaProfile: profile,
      runRoot: root,
      client,
      signal: controller.signal,
      experiment: async (o) => {
        dispatched++;
        return runExperiment({
          ...o,
          score: async (s) => {
            if (mode === "cancel") controller.abort();
            return scoreTables({
              ...s,
              timeout_ms: mode === "timeout" ? 1 : s.timeout_ms,
            });
          },
        });
      },
    });
    expect(result.status).not.toBe("completed");
    expect(result.best_experiment_id).toBeNull();
    expect(client.bodies).toHaveLength(1);
    expect(dispatched).toBe(1);
    const view = await inspectModeling(result.directory);
    const e = obj((view.manifest.experiments as unknown[])[0]);
    expect(e.score).toBeNull();
    expect(String(e.reason)).toContain("scoring_failure");
    expect(
      (await readdir(result.directory, { recursive: true })).some((p) =>
        p.endsWith("failure.json"),
      ),
    ).toBe(true);
    for (const name of ["fit", "predict"]) {
      const stage = obj(e[name]);
      expect(
        await dockerCommand([
          "ps",
          "-aq",
          "--filter",
          `label=org.statigent.run=${stage.run_id}`,
        ]),
      ).toBe("");
    }
  }
}, 180000);
