import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { dockerCommand } from "../../src/execution/docker";
import { validateModelingTask } from "../../src/modeling/config";
import { loadDataset, prepareDataset, select } from "../../src/modeling/data";
import {
  runExperiment,
  runStage,
  stageBytes,
} from "../../src/modeling/experiments";
import { readManifest } from "../../src/records/store";

const code = `from sklearn.compose import ColumnTransformer\nfrom sklearn.pipeline import make_pipeline\nfrom sklearn.linear_model import LinearRegression\ndef build_pipeline(seed):\n    import os\n    assert sorted(os.listdir('/input')) == ['candidate.py','data.csv','stage.json']\n    return make_pipeline(ColumnTransformer([('x','passthrough',['x'])]),LinearRegression())\n`;
test("a tree ensemble above the old 16 MiB limit is saved, collected on close and loaded in an independent prediction container", async () => {
  const root = resolve("runs/integration-modeling-large", randomUUID());
  const input = join(root, "input");
  await mkdir(input, { recursive: true });
  const rows = Array.from(
    { length: 1000 },
    (_, i) =>
      `${i},${Math.sin(i)},${Math.cos(i * 0.7)},${Math.sin(i * 0.01) + (i % 7)}`,
  ).join("\n");
  await writeFile(join(input, "train.csv"), `id,x,z,target\n${rows}\n`);
  await writeFile(
    join(input, "test.csv"),
    "id,x,z\n1001,0.1,0.3\n1002,0.5,0.7\n",
  );
  await prepareDataset({ ...source, input_root: input }, join(root, "data"));
  const task = validateModelingTask({
    schema_version: 2,
    method: "adaptive_eda",
    confirmation: { mode: "none" },
    resource_version: "smoke-v1",

    goal: "large model persistence",
    dataset_root: join(root, "data"),
    model_profile: "test",
    image: "statigent-runtime:dev",
  });
  const result = await runExperiment({
    root,
    task,
    ...(await loadDataset(task.dataset_root)),
    candidateId: "trees",
    signal: new AbortController().signal,
    remaining: () => 120000,
    code: "from sklearn.ensemble import ExtraTreesRegressor\ndef build_pipeline(seed):\n    return ExtraTreesRegressor(n_estimators=256,random_state=seed,n_jobs=1)\n",
  });
  expect(result.status, result.reason).toBe("completed");
  expect(result.fit?.output?.bytes).toBeGreaterThan(16 * 1024 ** 2);
  expect(result.score?.value).not.toBeNull();
  const fit = await readManifest(result.fit?.directory ?? "");
  expect(fit.workspace_collection.status).toBe("complete");
  const snapshots = fit.artifacts.filter(
    (a) => a.source_path === "model.joblib",
  );
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0]?.sha256).toBe(snapshots[1]?.sha256);
  for (const stage of [result.fit, result.predict])
    expect(
      await dockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=org.statigent.run=${stage?.run_id}`,
      ]),
    ).toBe("");
}, 180000);
async function setup() {
  const root = resolve("runs/integration-modeling", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "dataset"));
  const loaded = await loadDataset(join(root, "dataset"));
  const task = validateModelingTask({
    schema_version: 2,
    method: "adaptive_eda",
    confirmation: { mode: "none" },
    resource_version: "smoke-v1",

    goal: "regress",
    dataset_root: join(root, "dataset"),
    model_profile: "deepseek-flash",
    image: "statigent-runtime:dev",
  });
  return {
    root,
    task,
    ...loaded,
    signal: new AbortController().signal,
    remaining: () => 180000,
    candidateId: "linear",
    code,
  };
}
test("isolated regression trains, predicts and records trusted RMSE without validation labels in either stage", async () => {
  const options = await setup();
  const e = await runExperiment(options);
  expect(e.status, e.reason).toBe("completed");
  expect(e.score?.value).toBeLessThan(1e-8);
  expect(e.fit?.run_id).not.toBe(e.predict?.run_id);
  const fit = await readManifest(e.fit?.directory ?? ""),
    predict = await readManifest(e.predict?.directory ?? "");
  expect(fit.inputs.map((i) => i.path)).not.toContain("test.csv");
  expect(predict.inputs.map((i) => i.path)).toEqual([
    "candidate.py",
    "data.csv",
    "stage.json",
    "model.joblib",
  ]);
  if (!e.predict) throw new Error("Missing prediction");
  expect((await stageBytes(e.predict)).toString()).toContain("prediction");
  for (const stage of [e.fit, e.predict])
    expect(
      await dockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=org.statigent.run=${stage?.run_id}`,
      ]),
    ).toBe("");
}, 180000);
test("training timeout, artifact limit and cancellation cannot yield successful experiments", async () => {
  const o = await setup();
  const short = {
    ...o.task,
    limits: { ...o.task.limits },
    budget: { ...o.task.budget, fit_timeout_ms: 200 },
  };
  const timeout = await runStage({
    task: short,
    dataset: o.dataset,
    root: o.root,
    stage: "fit",
    code: "import time\ntime.sleep(30)",
    data: select(o.train, o.dataset.split.train, o.dataset.id_column),
    signal: o.signal,
    remainingMs: 20000,
  });
  expect(timeout.status).toBe("failed");
  expect(timeout.reason).toContain("timed_out");
  const limited = {
    ...o.task,
    limits: { ...o.task.limits, max_artifact_bytes: 32 },
  };
  const large = await runStage({
    task: limited,
    dataset: o.dataset,
    root: o.root,
    stage: "fit",
    code: o.code,
    data: o.train,
    signal: o.signal,
    remainingMs: 20000,
  });
  expect(large.status).toBe("failed");
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), 2000);
  const cancelled = await runStage({
    task: o.task,
    dataset: o.dataset,
    root: o.root,
    stage: "fit",
    code: "import time\ntime.sleep(30)",
    data: o.train,
    signal: cancel.signal,
    remainingMs: 20000,
  });
  clearTimeout(timer);
  expect(cancelled.status).toBe("failed");
  expect(cancelled.reason).toContain("cancelled");
  for (const s of [timeout, large, cancelled])
    expect(
      await dockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=org.statigent.run=${s.run_id}`,
      ]),
    ).toBe("");
}, 180000);
