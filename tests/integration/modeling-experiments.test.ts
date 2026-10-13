import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
async function setup() {
  const root = resolve("runs/integration-modeling", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "dataset"));
  const loaded = await loadDataset(join(root, "dataset"));
  const task = validateModelingTask({
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
  expect(e.rmse).toBeLessThan(1e-8);
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
