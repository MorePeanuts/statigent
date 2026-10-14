import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { validateModelingTask } from "../../src/modeling/config";
import { confirmationResult, shortlist } from "../../src/modeling/confirmation";
import { parseCsv } from "../../src/modeling/data";
import { loadDatasetV3 } from "../../src/modeling/dataset-v3";
import type { Experiment } from "../../src/modeling/experiments";
import { runExperimentV2 } from "../../src/modeling/experiments-v2";
import type { ScoreV2 } from "../../src/modeling/score-v2";
import { selectFileV2 } from "../../src/modeling/table-ops";
import {
  createValidationPlanV2,
  loadSearchMembersV2,
} from "../../src/modeling/validation-v2";
import { readManifest } from "../../src/records/store";

for (const kind of ["ordinal", "multiclass", "multilabel"] as const) {
  test(`file experiments ${kind}: search, two confirmations, diagnostics and final fit without test access`, async () => {
    const root = resolve(
      "runs/integration-modeling-experiments-v2",
      randomUUID(),
    );
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
        kind === "multilabel" ? "7" : "1",
      ],
      {
        timeout_ms: 10000,
        env: {
          ...commandEnvironment(),
          PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
        },
      },
    );
    const { root: sourceRoot, dataset } = await loadDatasetV3(
      resolve(root, "prepared"),
    );
    const p = dataset.protocol,
      members = await loadSearchMembersV2(sourceRoot, dataset);
    const labelFile = await selectFileV2({
      root,
      source: {
        ...dataset.training,
        path: resolve(sourceRoot, dataset.training.path),
      },
      columns: [p.id_column, ...p.targets.map((t) => t.name)],
      members: null,
      limits: dataset.limits,
      timeout_ms: 10000,
    });
    const labels = parseCsv(await Bun.file(labelFile.file.path).text());
    const plan = createValidationPlanV2(
      dataset,
      labels,
      members,
      "terminal_repeated_holdout",
    );
    // 删除测试分区的可达路径；内部搜索、确认和最终拟合均不得依赖它。
    await rename(
      resolve(sourceRoot, "final-prediction"),
      resolve(root, "withheld-test"),
    );
    const task = validateModelingTask({
      schema_version: 3,
      method: "no_eda",
      confirmation: { mode: "none" },
      resource_version: "synthetic-v2",
      goal: "verify file experiments",
      dataset_root: sourceRoot,
      model_profile: "offline",
      image: "statigent-runtime:modeling-benchmarks",
    });
    const code = `from sklearn.tree import DecisionTreeClassifier
from sklearn.multioutput import MultiOutputClassifier
def build_pipeline(seed):
    return ${kind === "multilabel" ? "MultiOutputClassifier(DecisionTreeClassifier(random_state=seed))" : "DecisionTreeClassifier(random_state=seed)"}
`;
    const common = {
      root,
      sourceRoot,
      dataset,
      task,
      code,
      candidateId: "fixed-tree",
      signal: new AbortController().signal,
      remaining: () => 120000,
    };
    const search = await runExperimentV2({
      ...common,
      evaluation: plan.search,
    });
    expect(search.status, search.reason).toBe("completed");
    expect(search.score?.partition).toBe("search-validation");
    expect(
      search.training_diagnostic?.status,
      search.training_diagnostic?.reason,
    ).toBe("available");
    expect(search.training_diagnostic?.score?.partition).toBe(
      "search-training",
    );
    expect(search.score?.components).toHaveLength(
      kind === "multilabel" ? 7 : 0,
    );
    const candidates = shortlist([search], p, plan),
      trials: Experiment<ScoreV2>[] = [];
    for (const evaluation of plan.confirmation) {
      const trial = await runExperimentV2({
        ...common,
        evaluation,
        sourceSearchExperimentId: search.id,
      });
      expect(trial.status, trial.reason).toBe("completed");
      expect(trial.score?.partition).toBe("confirmation-validation");
      expect(trial.training_diagnostic).toBeUndefined();
      trials.push(trial);
    }
    expect(confirmationResult(candidates, trials, p, plan).status).toBe(
      "complete",
    );
    const final = await runExperimentV2({
      ...common,
      evaluation: plan.final,
      fitOnly: true,
      sourceSearchExperimentId: search.id,
    });
    expect(final.status, final.reason).toBe("completed");
    expect(final.reason).toBe("model_frozen");
    expect(final.predict).toBeNull();
    expect(final.score).toBeNull();
    for (const experiment of [search, ...trials, final]) {
      for (const stage of [
        experiment.fit,
        experiment.predict,
        experiment.training_diagnostic?.prediction,
      ]) {
        if (!stage) continue;
        const manifest = await readManifest(stage.directory);
        expect(
          manifest.inputs.every((f) => !/test|evaluator/.test(f.path)),
        ).toBe(true);
        const data = parseCsv(
          await Bun.file(
            resolve(root, "inputs", stage.run_id, "data.csv"),
          ).text(),
        );
        expect(data.columns).toEqual(
          stage === experiment.fit
            ? [
                p.id_column,
                ...p.feature_columns,
                ...p.targets.map((t) => t.name),
              ]
            : [p.id_column, ...p.feature_columns],
        );
      }
    }
  }, 180000);
}
