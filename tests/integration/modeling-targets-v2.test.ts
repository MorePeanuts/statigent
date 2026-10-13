import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { dockerCommand } from "../../src/execution/docker";
import { validateModelingTask } from "../../src/modeling/config";
import { parseCsv } from "../../src/modeling/data";
import { loadDatasetV3 } from "../../src/modeling/dataset-v3";
import { runStage, stageBytes } from "../../src/modeling/experiments";
import { readManifest } from "../../src/records/store";

for (const [kind, count] of [
  ["regression", 1],
  ["binary", 1],
  ["ordinal", 1],
  ["multiclass", 1],
  ["multilabel", 2],
  ["multilabel", 7],
] as const) {
  test(`stage 4 Docker ${kind}/${count}: real estimator fit, frozen metadata and isolated reload`, async () => {
    const root = resolve("runs/integration-modeling-targets", randomUUID());
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
        "from pathlib import Path; import sys; from test_modeling_runner_v4 import fixture; fixture(Path(sys.argv[1]),sys.argv[2],int(sys.argv[3]))",
        root,
        kind,
        String(count),
      ],
      {
        timeout_ms: 10000,
        env: {
          ...commandEnvironment(),
          PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
        },
      },
    );
    const loaded = await loadDatasetV3(resolve(root, "prepared"));
    const dataset = loaded.dataset;
    const task = validateModelingTask({
      schema_version: 3,
      method: "no_eda",
      confirmation: { mode: "none" },
      resource_version: "synthetic-v2",
      goal: "verify versioned targets",
      dataset_root: loaded.root,
      model_profile: "offline",
      image: "statigent-runtime:modeling-benchmarks",
    });
    const base = `from pathlib import Path
import os
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from sklearn.multioutput import MultiOutputClassifier
assert set(p.name for p in Path('/input').iterdir()) <= {'candidate.py','data.csv','features.json','stage.json','model.joblib'}
assert not Path('/input/evaluator').exists()
assert not Path('/Users/liaofeng/Documents/statigent').exists()
assert not os.environ.get('OPENAI_API_KEY')
def build_pipeline(seed):
    return ${kind === "regression" ? "DecisionTreeRegressor(random_state=seed)" : kind === "multilabel" ? "MultiOutputClassifier(DecisionTreeClassifier(random_state=seed))" : "DecisionTreeClassifier(random_state=seed)"}
`;
    const common = {
      root,
      task,
      dataset,
      code: base,
      stageVersion: 4 as const,
      featureSchema: {
        ...dataset.feature_schema,
        path: resolve(loaded.root, dataset.feature_schema.path),
      },
      signal: new AbortController().signal,
      remainingMs: 60000,
    };
    const fit = await runStage({
      ...common,
      stage: "fit",
      data: {
        ...dataset.training,
        path: resolve(loaded.root, dataset.training.path),
      },
    });
    expect(fit.status, fit.reason).toBe("completed");
    expect(fit.stage_version).toBe(4);
    expect(fit.metadata?.sha256).toHaveLength(64);
    if (!dataset.prediction)
      throw new Error("Fixture missing prediction features");
    const predicted = await runStage({
      ...common,
      stage: "predict",
      model: await stageBytes(fit),
      data: {
        ...dataset.prediction,
        path: resolve(loaded.root, dataset.prediction.path),
      },
    });
    expect(predicted.status, predicted.reason).toBe("completed");
    const table = parseCsv((await stageBytes(predicted)).toString());
    expect(table.rows).toHaveLength(4);
    if (kind === "ordinal")
      expect(table.rows.map((r) => r[1])).toEqual(["3", "5", "8", "3"]);
    if (kind === "multilabel")
      for (let i = 0; i < count; i++)
        expect(table.rows[1]?.[1 + 3 * i]).toBe("1");
    if (kind === "multiclass")
      expect(JSON.parse(table.rows[0]?.[1] ?? "null")).toHaveLength(3);
    for (const result of [fit, predicted]) {
      const manifest = await readManifest(result.directory);
      expect(
        manifest.inputs.some(
          (f) => f.path.includes("evaluator") || f.path.includes("test.csv"),
        ),
      ).toBe(false);
      expect(
        await dockerCommand([
          "ps",
          "-aq",
          "--filter",
          `label=org.statigent.run=${result.run_id}`,
        ]),
      ).toBe("");
    }
  }, 120000);
}
