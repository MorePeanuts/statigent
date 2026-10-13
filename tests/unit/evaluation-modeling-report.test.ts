import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aggregate } from "../../src/evaluation/aggregate";
import { createModelingBenchmark } from "../../src/evaluation/benchmarks/modeling/adapter";
import { exportComparison } from "../../src/evaluation/comparison";
import { describeFile } from "../../src/evaluation/files";
import { buildPlan, Registry } from "../../src/evaluation/plan";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { inspect } from "../../src/evaluation/records";
import { createReport } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { predictionColumnsV2 } from "../../src/modeling/protocol-v2";
import { fixtureRegistry, submission } from "../helpers/evaluation";

let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "modeling-report-")));
  await command(
    [
      "uv",
      "run",
      "--offline",
      "--frozen",
      "--no-sync",
      "python",
      "-c",
      `
from pathlib import Path
import sys
from test_modeling_dataset_v3 import prepare
prepare(Path(sys.argv[1]), kind='regression', metric_id='mae-v1',
        targets=[dict(name='y', classes=None, positive_class=None, levels=None)],
        train=[(f'train:{i}', i, dict(signal=i, token='a', y=i)) for i in range(20)],
        prediction=[('test:0', 0, dict(signal=1, token='a')), ('test:1', 1, dict(signal=3, token='a'))],
        labels=[('test:0', ['1']), ('test:1', ['3'])],
        provenance=dict(benchmark='dsbench-modeling', task_id='fixture', source_revision='a'*40, export=dict(columns=['Id','y'], identity='source-row')))
`,
      join(root, "data"),
    ],
    {
      timeout_ms: 10000,
      env: {
        ...commandEnvironment(),
        PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
      },
    },
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function batch(incomplete: boolean) {
  const benchmark = createModelingBenchmark("dsbench-modeling", {
    references: async (_root, _task, direction, value) => {
      expect(direction).toBe("minimize");
      return {
        rpg: value === null ? null : Math.max(0, (value - 10) / (2 - 10)),
        reference_identity: { fixture: true },
        dependencies: {},
      };
    },
  });
  const registry = new Registry().benchmark(benchmark);
  let called = 0;
  registry.agent({
    ...fixtureRegistry().getAgent("fixture"),
    capabilities: {
      schema_version: 3,
      outputs: ["predictions"],
      phase_isolation: true,
      trajectory: "none",
      model: "none",
      seed: "execution",
      isolation: "docker",
      model_budget: false,
      usage: "not_applicable",
    },
    options: (v) => {
      if (JSON.stringify(v) !== JSON.stringify({ method: "no_eda" }))
        throw new Error("Unexpected fixture options");
      return { method: "no_eda" };
    },
    run: async (i) => {
      called++;
      if (called > 1)
        return {
          ...submission(i.unit_id),
          schema_version: 3,
          status: "failed",
          record_error: incomplete,
          reason: "controlled_failure",
        };
      if (i.task.output.kind !== "predictions")
        throw new Error("Prediction fixture");
      const output = i.task.output;
      await writeFile(
        join(i.deliverables_root, output.prediction_file),
        `${predictionColumnsV2(output.protocol).join(",")}\ntest:1,4\ntest:0,2\n`,
      );
      const expected = i.task.inputs.find((f) =>
        f.path.endsWith("final-prediction/test.csv"),
      );
      if (!expected) throw new Error("Missing expected features");
      await writeFile(
        join(i.deliverables_root, output.manifest_file),
        JSON.stringify({
          schema_version: 1,
          kind: "modeling-predictions",
          task_id: i.task.id,
          task_version: i.task.version,
          protocol: output.protocol,
          seed: i.seed,
          dataset_sha256: i.task.version,
          expected_features: { ...expected, path: "final-prediction/test.csv" },
          predictions: await describeFile(
            i.deliverables_root,
            output.prediction_file,
          ),
          export: null,
          native_model: {
            run_id: "fixture-native",
            frozen_id: "b".repeat(64),
            sha256: "c".repeat(64),
            bytes: 100,
            delivery_sha256: "d".repeat(64),
          },
          execution_preparation: null,
          workflow: {
            search_end: { kind: "protected", reason: "tokens" },
            delivery_status: "completed",
            prediction_status: "completed",
            reproduction_status: "not_run",
            search_best_experiment_id: "candidate",
            selected_experiment_id: "candidate",
            confirmation: null,
            usage: {},
            wall_ms: 10,
          },
        }),
      );
      return { ...submission(i.unit_id), schema_version: 3 };
    },
  });
  const options = {
    prepared_root: root,
    datasets: { fixture: "data" },
    data_root: root,
  };
  const plan = await buildPlan(
    {
      schema_version: 3,
      cache_policy: "disabled",
      purpose: "development",
      development_overlap:
        "Synthetic scoring fixture, no model behavior claims",
      benchmark: {
        adapter: benchmark.id,
        version: "a".repeat(40),
        options,
        task_ids: ["fixture"],
      },
      agents: [
        {
          id: "fixture",
          adapter: "fixture",
          options: { method: "no_eda" },
          require_seed: true,
        },
      ],
      seed: 17,
      repetitions: incomplete ? 3 : 2,
      task_budget: {
        timeout_ms: 30000,
        model_attempts: null,
        total_tokens: null,
      },
      batch_budget: {
        timeout_ms: 60000,
        model_attempts: null,
        total_tokens: null,
      },
    },
    registry,
  );
  const run = await runEvaluation(plan, registry, join(root, "batches"), {
    environment: {},
  });
  return { ...run, registry, benchmark, options, plan };
}

test("DSBench minimizing native score and RPG > 1 retain failed units in the denominator", async () => {
  const run = await batch(false),
    view = await inspect(run.directory);
  expect(view.records[0]?.score?.details.native).toMatchObject({ value: 1 });
  expect(view.records[0]?.score?.metrics).toContainEqual({
    name: "rpg",
    value: 1.125,
    minimum: 0,
    maximum: null,
    direction: "higher",
  });
  expect(view.records[1]?.score?.details.native).toMatchObject({ value: null });
  const report = await createReport(run.directory, run.registry);
  expect(report.report.groups[0]?.metrics).toEqual({
    completion: 0.5,
    rpg: 0.5625,
  });
  expect(report.report.rows[0]?.native_value).toBe(1);
  expect(report.report.rows[0]?.search_end).toEqual({
    kind: "protected",
    reason: "tokens",
  });
  expect(report.report.rows[1]?.native_value).toBe(null);
  const compared = await exportComparison(run.directory, report.score_id);
  const pairs = await Bun.file(join(compared.directory, "pairs.json")).json();
  expect(pairs.rows).toHaveLength(2);
  expect(pairs.aggregation).toBe("none");
  expect(pairs.rows.map((r: { seed: number }) => r.seed)).toEqual([17, 18]);
  expect(JSON.stringify(run.plan.tasks)).not.toContain("reference_identity");
  const first = view.records[0];
  if (!first?.score) throw new Error("Missing score");
  expect(
    aggregate([
      {
        ...first,
        scoring_status: "failed",
        score: {
          ...first.score,
          status: "failed",
          metrics: [],
          error: "private_resource_error",
        },
      },
      ...view.records.slice(1),
    ]).metrics,
  ).toEqual({ completion: null, rpg: null });
});

test("unrun and scoring errors leave complete modeling summaries null and retain all pair rows", async () => {
  const run = await batch(true),
    report = await createReport(run.directory, run.registry);
  expect(report.report.groups[0]?.status).toBe("incomplete");
  expect(report.report.groups[0]?.metrics).toEqual({
    completion: null,
    rpg: null,
  });
  const compared = await exportComparison(run.directory, report.score_id);
  const pairs = await Bun.file(join(compared.directory, "pairs.json")).json();
  expect(pairs.rows).toHaveLength(3);
  expect(pairs.rows[2].execution_status).toBe("not_run");
  expect(pairs.rows[2].native_value).toBe(null);
  expect(pairs.rows[2].reproduction_status).toBe("not_run");
  const task = run.plan.tasks[0];
  if (!task) throw new Error("Missing task");
  await chmod(join(root, "data/evaluator/labels.csv"), 0o600);
  await writeFile(join(root, "data/evaluator/labels.csv"), "damaged");
  await expect(
    run.benchmark.score(
      run.options,
      task,
      { ...submission(), status: "failed" },
      { deliverables_root: root, scoring: {}, judge: null },
    ),
  ).rejects.toThrow("integrity");
});
