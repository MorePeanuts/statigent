import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createModelingBenchmark } from "../../src/evaluation/benchmarks/modeling/adapter";
import { cleanupEvaluation } from "../../src/evaluation/cleanup";
import { describeFile, verifyFiles } from "../../src/evaluation/files";
import { buildPlan } from "../../src/evaluation/plan";
import { readPredictionManifest } from "../../src/evaluation/predictions";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { inspect, readSubmission } from "../../src/evaluation/records";
import { defaultRegistry } from "../../src/evaluation/registry";
import { createReport, rescore } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { inspectModeling } from "../../src/modeling/records";
import { modelingSettings } from "../helpers/evaluation-modeling";

test("two modeling benchmarks execute, freeze and rescore fresh deterministic predictions without native model access", async () => {
  const root = resolve("runs/evaluation-modeling-batch", randomUUID());
  await mkdir(root, { recursive: true });
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
import sys, csv
from test_modeling_prepare_ds import source, LIMITS
from statigent_benchmarks.prepare_ds import prepare_ds
from statigent_benchmarks.ds_catalog import sha256
from test_modeling_dataset_v3 import prepare
root = Path(sys.argv[1])
raw, task = source(root)
# 原格式夹具故意在数值列放入 '?'；闭环验收改为合法数值并重新冻结来源。
with (raw / 'test.csv').open(newline='') as stream:
    rows = list(csv.reader(stream))
for row in rows[1:]:
    row[-1] = '01'
with (raw / 'test.csv').open('w', newline='') as stream:
    csv.writer(stream).writerows(rows)
for ref in task['files']:
    if ref['path'] == 'test.csv':
        ref.update(bytes=(raw / 'test.csv').stat().st_size, sha256=sha256(raw / 'test.csv'))
prepare_ds(raw, task, root / 'ds', seed=17, limits=LIMITS)
prepare(root / 'tab', kind='binary', metric_id='roc-auc-v1',
        targets=[dict(name='EC1', classes=None, positive_class='1', levels=None)], labels=[('test:0', ['1']), ('test:1', ['0'])],
        prediction=[('test:0', 0, dict(signal=10, token='?')), ('test:1', 1, dict(signal=11, token='01'))],
        provenance=dict(benchmark='tabarena-lite', task_id='456', source_revision='a'*40, outer_split='openml-r0f0', openml=dict(dataset_id='123', version=1, repeat=0, fold=0)))
`,
      root,
    ],
    {
      timeout_ms: 10000,
      env: {
        ...commandEnvironment(),
        PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
      },
    },
  );
  for (const [benchmark, taskId, prefix] of [
    ["dsbench-modeling", "titanic", "ds"],
    ["tabarena-lite", "456", "tab"],
  ] as const) {
    const registry = defaultRegistry();
    if (benchmark === "dsbench-modeling") {
      registry.benchmarks.set(
        benchmark,
        createModelingBenchmark(benchmark, {
          references: async (_root, _id, _direction, value) => ({
            rpg: value === null ? null : Math.max(0, (value - 0.5) / 0.5),
            reference_identity: { fixture: "synthetic-only" },
            dependencies: {},
          }),
        }),
      );
    }
    const plan = await buildPlan(
      {
        schema_version: 3,
        cache_policy: "disabled",
        purpose: "development",
        development_overlap: "synthetic verification; no research score",
        benchmark: {
          adapter: benchmark,
          version: "a".repeat(40),
          options: {
            prepared_root: root,
            datasets: { [taskId]: prefix },
            data_root: resolve("benchmarks"),
          },
          task_ids: [taskId],
        },
        agents: [
          {
            id: "deterministic",
            adapter: "deterministic-modeling",
            options: modelingSettings,
            require_seed: true,
          },
        ],
        repetitions: 1,
        seed: 42,
        task_budget: {
          timeout_ms: 300000,
          model_attempts: null,
          total_tokens: null,
        },
        batch_budget: {
          timeout_ms: 400000,
          model_attempts: null,
          total_tokens: null,
        },
      },
      registry,
    );
    const run = await runEvaluation(plan, registry, join(root, "batches"), {
      environment: { verification: "synthetic" },
    });
    const view = await inspect(run.directory),
      record = view.records[0],
      task = plan.tasks[0];
    if (!record || !task) throw new Error("Missing result");
    expect(record.execution_status, record.reason).toBe("completed");
    expect(record.scoring_status, record.score?.error ?? "").toBe("scored");
    expect(
      record.score?.metrics.find((m) => m.name === "completion")?.value,
    ).toBe(1);
    const stored = await readSubmission(run.directory, record);
    if (!stored?.submission.native_run) throw new Error("No native execution");
    expect(stored.submission.usage.source).toBe("not_applicable");
    expect(stored.submission.usage.attempts).toBe(0);
    expect(stored.submission.deliverables.map((f) => f.path)).toEqual([
      "export.csv",
      "prediction-manifest.json",
      "predictions.csv",
    ]);
    const native = await inspectModeling(
      stored.submission.native_run.directory,
    );
    expect(native.unconfirmed_experiments).toHaveLength(0);
    const manifest = await readPredictionManifest(
      stored.deliverables_root,
      task,
      { seed: 42 },
    );
    expect(manifest.seed).toBe(42);
    expect(manifest.dataset_sha256).not.toBe(task.version);
    const report = await createReport(run.directory, registry);
    const old = await describeFile(report.directory, "report.json");
    const originalFiles = stored.submission.deliverables;
    const cleaned: string[] = [];
    await cleanupEvaluation(run.directory, {
      external: async () => {},
      native: async (id) => {
        cleaned.push(id);
        return [];
      },
    });
    expect(cleaned.length).toBeGreaterThanOrEqual(5);
    expect(new Set(cleaned).size).toBe(cleaned.length);
    await rename(
      join(run.directory, "native"),
      join(run.directory, "native-unavailable"),
    );
    const repeated = await rescore(run.directory, registry);
    expect(repeated.score_id).not.toBe(report.score_id);
    expect(repeated.report.rows[0]?.metric_completion).toBe(1);
    await verifyFiles(report.directory, [old]);
    await verifyFiles(stored.deliverables_root, originalFiles);
    const predictionPath = join(stored.deliverables_root, "predictions.csv");
    await chmod(predictionPath, 0o600);
    await writeFile(predictionPath, "tampered");
    await expect(rescore(run.directory, registry)).rejects.toThrow("integrity");
  }
}, 180000);
