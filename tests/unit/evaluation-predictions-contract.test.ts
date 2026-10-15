import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyUsage,
  validateCapabilities,
  validateScore,
  validateSubmission,
  validateTask,
} from "../../src/evaluation/contracts";
import {
  freezeDeliverables,
  verifyDeliverables,
} from "../../src/evaluation/deliverables";
import { describeFile } from "../../src/evaluation/files";
import { buildPlan } from "../../src/evaluation/plan";
import { readPredictionManifest } from "../../src/evaluation/predictions";
import { DEFAULT_DATA_LIMITS } from "../../src/modeling/data-limits";
import { validateProtocolV2 } from "../../src/modeling/protocol-v2";
import fixtures from "../fixtures/modeling-protocol-v2.json";
import {
  config,
  fixtureRegistry,
  submission,
  task,
} from "../helpers/evaluation";

const protocol = validateProtocolV2(
  fixtures.valid.find((v) => v.input.metric_id === "r2-sklearn-v1")?.protocol,
);
const search = [
  "dataset.json",
  "search/train.csv",
  "search/features.json",
  "search/split.json",
];
export const predictionTask = validateTask({
  ...task,
  schema_version: 3,
  inputs: [...search, "final-prediction/test.csv"].map((path) => ({
    path,
    sha256: "a".repeat(64),
    bytes: 10,
  })),
  output: {
    kind: "predictions",
    instructions: "Return frozen predictions",
    protocol,
    input_manifest: "dataset.json",
    prediction_file: "predictions.csv",
    export_file: "export.csv",
    manifest_file: "prediction-manifest.json",
    limits: DEFAULT_DATA_LIMITS,
    max_total_bytes: 2 * DEFAULT_DATA_LIMITS.max_file_bytes + 1024 ** 2,
  },
  phase_inputs: {
    search,
    eda: search,
    confirmation: search,
    final_fit: search,
    prediction: ["search/features.json", "final-prediction/test.csv"],
  },
});

test("prediction contract requires complete phase whitelists and excludes evaluator paths", () => {
  expect(predictionTask.schema_version).toBe(3);
  for (const change of [
    { schema_version: 2 },
    { phase_inputs: undefined },
    {
      phase_inputs: {
        ...predictionTask.phase_inputs,
        eda: ["evaluator/labels.csv"],
      },
    },
    { phase_inputs: { ...predictionTask.phase_inputs, final_fit: [] } },
    {
      phase_inputs: {
        ...predictionTask.phase_inputs,
        search: ["../train.csv"],
      },
    },
    {
      inputs: [
        ...predictionTask.inputs,
        { path: "evaluator/labels.csv", sha256: "a".repeat(64), bytes: 1 },
      ],
      phase_inputs: {
        ...predictionTask.phase_inputs,
        search: [...search, "evaluator/labels.csv"],
      },
    },
  ])
    expect(() => validateTask({ ...predictionTask, ...change })).toThrow();
  const cap = {
    schema_version: 3,
    outputs: ["predictions"],
    phase_isolation: true,
    trajectory: "none",
    model: "none",
    seed: "execution",
    isolation: "docker",
    model_budget: false,
    usage: "not_applicable",
  };
  expect(validateCapabilities(cap).phase_isolation).toBe(true);
  for (const change of [
    { schema_version: 2 },
    { phase_isolation: false },
    { phase_isolation: "yes" },
  ])
    expect(() => validateCapabilities({ ...cap, ...change })).toThrow();
});

test("old agent capabilities cannot plan phased prediction tasks", async () => {
  const registry = fixtureRegistry();
  const benchmark = registry.getBenchmark(config().benchmark.adapter);
  benchmark.catalog = async () => ({
    tasks: [predictionTask],
    source_root: "/tmp/fixture",
    provenance: { version: config().benchmark.version },
  });
  benchmark.preflight = async () => {};
  await expect(
    buildPlan(
      {
        ...config(),
        schema_version: 3,
        benchmark: { ...config().benchmark, task_ids: [predictionTask.id] },
      },
      registry,
    ),
  ).rejects.toThrow("phase isolation");
});

test("v3 metrics allow unbounded finite values; old bounds and nonfinite rejection remain", () => {
  const base = {
    schema_version: 3,
    unit_id: "unit-1",
    protocol: "test",
    status: "scored",
    details: {},
    error: null,
    judge: null,
  };
  const metric = {
    name: "r2",
    value: -1000,
    minimum: null,
    maximum: 1,
    direction: "higher",
  };
  expect(
    validateScore({ ...base, metrics: [metric] }, "unit-1").metrics[0]?.value,
  ).toBe(-1000);
  for (const value of [Infinity, -Infinity, NaN])
    expect(() =>
      validateScore({ ...base, metrics: [{ ...metric, value }] }, "unit-1"),
    ).toThrow();
  expect(() =>
    validateScore({ ...base, schema_version: 2, metrics: [metric] }, "unit-1"),
  ).toThrow();
  expect(() =>
    validateScore({ ...base, metrics: [{ ...metric, minimum: 2 }] }, "unit-1"),
  ).toThrow();
});

test("prediction file limits exceed report limits only under the frozen v3 contract", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "prediction-limits-")),
  );
  try {
    await writeFile(
      join(root, "predictions.csv"),
      Buffer.alloc(9 * 1024 ** 2, 48),
    );
    await expect(freezeDeliverables(root)).rejects.toThrow("too large");
    const files = await freezeDeliverables(root, predictionTask.output);
    await verifyDeliverables(root, files, predictionTask.output);
    const value = { ...submission(), schema_version: 3, deliverables: files };
    expect(
      validateSubmission(value, value.unit_id, {
        output: predictionTask.output,
      }).deliverables,
    ).toEqual(files);
    expect(() => validateSubmission(value, value.unit_id)).toThrow("too large");
    expect(() =>
      validateSubmission({ ...value, schema_version: 2 }, value.unit_id, {
        output: predictionTask.output,
      }),
    ).toThrow("too large");
    const file = files[0];
    if (!file) throw new Error("Missing frozen fixture");
    await expect(
      verifyDeliverables(
        root,
        [{ ...file, sha256: "b".repeat(64) }],
        predictionTask.output,
      ),
    ).rejects.toThrow("integrity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prediction manifest binds files, seed and large model identity without opening model storage", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "prediction-manifest-")),
  );
  try {
    const task = { ...predictionTask, version: "a".repeat(64) };
    await writeFile(
      join(root, "predictions.csv"),
      "sample_id,target\ntest:0,1\n",
    );
    await writeFile(join(root, "export.csv"), "Id,target\n0,1\n");
    const manifest = {
      schema_version: 1,
      kind: "modeling-predictions",
      task_id: task.id,
      task_version: task.version,
      protocol,
      seed: 17,
      dataset_sha256: task.version,
      expected_features: {
        path: "final-prediction/test.csv",
        sha256: "a".repeat(64),
        bytes: 10,
      },
      predictions: await describeFile(root, "predictions.csv"),
      export: await describeFile(root, "export.csv"),
      native_model: {
        run_id: "absent-native",
        frozen_id: "b".repeat(64),
        sha256: "c".repeat(64),
        bytes: 8 * 1024 ** 3,
        delivery_sha256: "d".repeat(64),
      },
      execution_preparation: null,
      workflow: {
        search_end: { kind: "autonomous", reason: "finished" },
        delivery_status: "completed",
        prediction_status: "completed",
        reproduction_status: "not_run",
        search_best_experiment_id: "best",
        selected_experiment_id: "selected",
        confirmation: null,
        usage: {},
        wall_ms: 10,
      },
    };
    const save = (value: unknown) =>
      writeFile(join(root, "prediction-manifest.json"), JSON.stringify(value));
    await save(manifest);
    expect(
      (await readPredictionManifest(root, task, { seed: 17 })).native_model
        ?.bytes,
    ).toBe(8 * 1024 ** 3);
    await expect(
      readPredictionManifest(root, task, { seed: 42 }),
    ).rejects.toThrow("seed");
    const external = {
      ...manifest,
      schema_version: 2,
      native_model: null,
      producer: {
        adapter: "autogluon",
        method: "autogluon",
        version: "autogluon-cpu-v1",
        config_hash: "e".repeat(64),
        run_id: "external-run",
      },
      model_bundle: {
        bundle_id: "b".repeat(64),
        manifest_sha256: "c".repeat(64),
        bytes: 8 * 1024 ** 3,
        file_count: 1000,
        entrypoint: "predict.py",
        image: `sha256:${"d".repeat(64)}`,
        platform: "linux/arm64",
        frozen_at: new Date().toISOString(),
      },
      workflow: {
        search_end: { status: "completed", reason: "explicit" },
        delivery_status: "completed",
        prediction_status: "completed",
        reproduction_status: "not_run",
        confirmation: "not_applicable",
        usage: emptyUsage("not_applicable"),
        wall_ms: 10,
      },
    };
    await save(external);
    const readExternal = await readPredictionManifest(root, task, { seed: 17 });
    expect(readExternal.predictions).toEqual(manifest.predictions);
    expect(readExternal.native_model).toBeNull();
    expect(readExternal.producer?.method).toBe("autogluon");
    for (const patch of [
      { native_model: manifest.native_model },
      { producer: { ...external.producer, method: "react" } },
      { workflow: { ...external.workflow, selected_experiment_id: "fake" } },
      { model_bundle: { ...external.model_bundle, entrypoint: "../escape" } },
    ]) {
      await save({ ...external, ...patch });
      await expect(readPredictionManifest(root, task)).rejects.toThrow();
    }
    for (const patch of [
      { predictions: { ...manifest.predictions, sha256: "f".repeat(64) } },
      { predictions: { ...manifest.predictions, path: "other.csv" } },
      { predictions: { ...manifest.predictions, bytes: 33 * 1024 ** 2 } },
      {
        native_model: {
          ...manifest.native_model,
          path: "/native/model.joblib",
        },
      },
      { export: null },
    ]) {
      await save({ ...manifest, ...patch });
      await expect(readPredictionManifest(root, task)).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
