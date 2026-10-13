import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { dockerCommand } from "../../src/execution/docker";
import { validateConfig } from "../../src/execution/protocol";
import { validateModelingTask } from "../../src/modeling/config";
import { loadDataset, prepareDataset, select } from "../../src/modeling/data";
import { reproduce } from "../../src/modeling/delivery";
import {
  runExperiment,
  runStage,
  stageBytes,
} from "../../src/modeling/experiments";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { createValidationPlan } from "../../src/modeling/validation";
import { obj } from "../../src/models/validation";
import { readManifest } from "../../src/records/store";
import { lastFeedback, profile, reply, ScriptClient } from "../helpers/agent";
import { baselineCode, finishCall, trainCall } from "../helpers/modeling";

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
    schema_version: 3,
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
    stageVersion: 2,
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
    schema_version: 3,
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

test("compressed artifact rejection can be repaired and delivered without losing failed history", async () => {
  const o = await setup();
  const client = new ScriptClient((body, i) => {
    if (i === 0)
      return reply([
        trainCall(
          "import random\nfrom sklearn.dummy import DummyRegressor\ndef build_pipeline(seed):\n    model=DummyRegressor()\n    model.payload=random.Random(seed).randbytes(8192)\n    return model\n",
        ),
      ]);
    if (i === 1) {
      const failed = obj(lastFeedback(body).result);
      expect(failed.diagnostic).toContain("model_artifact_limit:");
      return reply([
        trainCall(baselineCode, [], null, {
          candidateUpdates: [],
          repairOf: String(failed.experiment_id),
        }),
      ]);
    }
    return reply([finishCall(body)]);
  });
  const result = await runModeling({
    task: {
      ...o.task,
      method: "no_eda",
      limits: { ...o.task.limits, max_artifact_bytes: 2048 },
    },
    profile,
    edaProfile: profile,
    client,
    runRoot: o.root,
  });
  expect(result.status, result.reason).toBe("completed");
  const manifest = obj(
    await Bun.file(join(result.directory, "modeling.json")).json(),
  );
  if (!Array.isArray(manifest.experiments)) throw Error("Missing experiments");
  const experiments = manifest.experiments.map(obj);
  expect(experiments.map((e) => e.status)).toEqual([
    "failed",
    "completed",
    "completed",
  ]);
  expect(obj(experiments[0]?.fit).output).toBeNull();
  const fit = obj(experiments[1]?.fit);
  expect(fit.stage_version).toBe(3);
  const native = await readManifest(String(fit.directory));
  expect(() => validateConfig(native.config)).not.toThrow();
  expect(client.bodies).toHaveLength(3);
  await inspectModeling(result.directory);
  expect(
    (await reproduce(result.directory, join(o.root, "reproduced"))).status,
  ).toBe("passed");
}, 180000);
test("isolated regression trains, predicts and records trusted RMSE without validation labels in either stage", async () => {
  const options = await setup();
  const e = await runExperiment({
    ...options,
    evaluation: createValidationPlan(options.dataset, options.train, "none")
      .search,
  });
  expect(e.status, e.reason).toBe("completed");
  expect(e.score?.value).toBeLessThan(1e-8);
  expect(e.training_diagnostic).toMatchObject({
    partition: "train",
    status: "available",
    model_sha256: e.fit?.output?.sha256,
  });
  expect(e.training_diagnostic?.score?.value).toBeLessThan(1e-8);
  const training = e.training_diagnostic?.prediction;
  if (!training) throw new Error("Missing training predictions");
  const diagnostic = await readManifest(training.directory);
  expect(diagnostic.inputs.map((i) => i.path)).toEqual([
    "candidate.py",
    "data.csv",
    "stage.json",
    "model.joblib",
  ]);
  const diagnosticData = await readFile(
    join(options.root, "inputs", training.run_id, "data.csv"),
    "utf8",
  );
  expect(diagnosticData.split("\n")[0]).not.toContain("target");
  expect(diagnosticData.trim().split("\n")).toHaveLength(
    options.dataset.split.train.length + 1,
  );
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
  expect(large.reason).toContain(
    "model_artifact_limit:compressed model.joblib bytes=",
  );
  expect(large.output).toBeNull();
  const rejected = await readManifest(large.directory);
  expect(rejected.workspace_collection.status).toBe("complete");
  expect(rejected.artifacts.some((a) => a.source_path === "model.joblib")).toBe(
    false,
  );
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

test("confirmation refits on each frozen membership with its model seed and independent containers", async () => {
  const { createValidationPlan } = await import(
    "../../src/modeling/validation"
  );
  const o = await setup(),
    plan = createValidationPlan(
      o.dataset,
      o.train,
      "terminal_repeated_holdout",
    );
  const sessions = new Set<string>();
  for (const evaluation of plan.confirmation) {
    const probe = `from sklearn.dummy import DummyRegressor\nimport pandas as pd\ndef build_pipeline(seed):\n    assert seed == ${evaluation.model_seed}\n    df = pd.read_csv('/input/data.csv', dtype={'id':str})\n    assert set(df['id']) == set(${JSON.stringify(evaluation.split.train)})\n    assert 'prior_fit' not in globals()\n    globals()['prior_fit'] = True\n    return DummyRegressor()\n`;
    const result = await runExperiment({
      ...o,
      code: probe,
      evaluation,
      sourceSearchExperimentId: "source",
    });
    expect(result.status, result.reason).toBe("completed");
    expect(result.score?.evaluation_id).toBe(evaluation.evaluation_id);
    expect(result.phase).toBe("confirmation");
    for (const stage of [result.fit, result.predict]) {
      if (!stage) throw new Error("Missing stage");
      expect(sessions.has(stage.run_id)).toBe(false);
      sessions.add(stage.run_id);
    }
  }
}, 180000);

test("ordinary training-diagnostic prediction failure retains validation eligibility without another fit", async () => {
  const o = await setup();
  const code =
    "import pandas as pd\nfrom sklearn.dummy import DummyRegressor\nclass DiagnosticFailure(DummyRegressor):\n    def predict(self,X):\n        if len(X)>4: raise ValueError('auxiliary prediction failed')\n        return super().predict(X)\ndef build_pipeline(seed):\n    return DiagnosticFailure()\n";
  const stages: string[] = [];
  const e = await runExperiment({
    ...o,
    code,
    evaluation: createValidationPlan(o.dataset, o.train, "none").search,
    onStage: async (id) => {
      stages.push(id);
    },
  });
  expect(e.status, e.reason).toBe("completed");
  expect(e.score).not.toBeNull();
  expect(e.training_diagnostic).toMatchObject({
    status: "unavailable",
    score: null,
  });
  expect(e.training_diagnostic?.reason).toContain(
    "auxiliary prediction failed",
  );
  expect(e.execution_confirmed).not.toBe(false);
  expect(stages).toHaveLength(3);
}, 90000);
