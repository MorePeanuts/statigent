import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile, verifyFiles } from "../../src/evaluation/files";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { loadDatasetV3 } from "../../src/modeling/dataset-v3";
import {
  loadFrozenModel,
  predictFrozenModel,
} from "../../src/modeling/frozen-model";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { call, profile, reply, ScriptClient } from "../helpers/agent";

for (const mode of ["fit_only", "fit_predict"] as const) {
  test(`native V2 ${mode}: frozen model reuses two predictions with zero fitting or model calls`, async () => {
    const root = resolve("runs/integration-modeling-frozen-v2", randomUUID());
    await mkdir(root, { recursive: true });
    const sourceRoot = join(root, "data");
    await command(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-c",
        `from pathlib import Path; import sys; from test_modeling_dataset_v3 import prepare; prepare(Path(sys.argv[1])${mode === "fit_only" ? ",prediction=None,labels=None" : ""})`,
        sourceRoot,
      ],
      {
        timeout_ms: 10000,
        env: {
          ...commandEnvironment(),
          PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
        },
      },
    );
    const datasetBefore = await describeFile(sourceRoot, "dataset.json");
    const { dataset } = await loadDatasetV3(sourceRoot);
    const code = `from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.tree import DecisionTreeClassifier
from sklearn.multioutput import MultiOutputClassifier
def build_pipeline(seed):
    return Pipeline([('features',ColumnTransformer([('signal','passthrough',['signal'])])),('model',MultiOutputClassifier(DecisionTreeClassifier(random_state=seed)))])
`;
    const client = new ScriptClient((_body, index) => {
      if (index === 0)
        return reply([
          call("run_experiment", {
            code,
            change: "fixed tree",
            reason: "synthetic acceptance",
          }),
        ]);
      if (index === 1)
        return reply([
          call("finish_modeling", { reason: "fixed acceptance complete" }),
        ]);
      throw new Error("No LLM calls after search closes");
    });
    const result = await runModeling({
      task: {
        schema_version: 4,
        delivery_mode: mode,
        method: "no_eda",
        confirmation: {
          mode: mode === "fit_only" ? "terminal_repeated_holdout" : "none",
        },
        ...(mode === "fit_only"
          ? { budget: { training_attempts: 6, final_reserve_ms: 750000 } }
          : {}),
        resource_version: "synthetic-v2",
        goal: "Validate isolated multi-target modeling",
        dataset_root: sourceRoot,
        model_profile: profile.id,
        image: "statigent-runtime:modeling-benchmarks",
      },
      profile,
      edaProfile: profile,
      client,
      runRoot: root,
    });
    expect(result.status, result.reason).toBe(
      mode === "fit_only" ? "model_frozen" : "completed",
    );
    expect(client.bodies).toHaveLength(2);
    expect(JSON.stringify(client.bodies)).not.toContain("test:0");
    const parent = await Bun.file(
      join(result.directory, "modeling.json"),
    ).json();
    expect(parent.schema_version).toBe(5);
    expect(parent.delivery.status).toBe(
      mode === "fit_only" ? "pending_prediction" : "completed",
    );
    expect(parent.experiments).toHaveLength(mode === "fit_only" ? 4 : 2);
    expect(parent.experiments.at(-1).predict).toBeNull();
    if (mode === "fit_only") {
      expect(parent.confirmation.status).toBe("complete");
      expect(parent.confirmation.trial_ids).toHaveLength(2);
    }
    expect(parent.basic_profile.profile.targets).toEqual(
      dataset.protocol.targets,
    );
    const inspected = await inspectModeling(result.directory);
    expect(inspected.unconfirmed_children).toHaveLength(0);
    expect(inspected.unconfirmed_experiments).toHaveLength(0);
    const frozen = await loadFrozenModel(result.directory);
    const frozenIdentity = await describeFile(
      result.directory,
      "frozen/model.json",
    );
    const featuresPath = join(root, "new-input.csv");
    await writeFile(
      featuresPath,
      "sample_id,signal,token\nnew:1,1.5,01\nnew:2,2.5,01\n",
    );
    const features = {
      ...(await describeFile(root, "new-input.csv")),
      path: featuresPath,
    };
    const predictions = [];
    for (let i = 0; i < 2; i++) {
      const predicted = await predictFrozenModel({
        frozenRoot: result.directory,
        runRoot: join(root, "predictions"),
        features,
        timeout_ms: 30000,
      });
      expect(predicted.status, predicted.reason).toBe("completed");
      expect(predicted.calls).toEqual({ models: 0, fits: 0, predictions: 1 });
      expect(predicted.model_sha256).toBe(frozen.model.sha256);
      predictions.push(predicted.predictions?.sha256);
    }
    expect(predictions[0]).toBe(predictions[1]);
    await writeFile(
      join(root, "bad.csv"),
      "sample_id,signal,token,EC1\nnew:1,1.5,01,1\n",
    );
    const bad = await predictFrozenModel({
      frozenRoot: result.directory,
      runRoot: join(root, "predictions"),
      features: {
        ...(await describeFile(root, "bad.csv")),
        path: join(root, "bad.csv"),
      },
      timeout_ms: 30000,
    });
    expect(bad.status).toBe("failed");
    expect(bad.reason).toContain("columns/target order");
    expect(bad.predictions).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await predictFrozenModel({
      frozenRoot: result.directory,
      runRoot: join(root, "predictions"),
      features,
      timeout_ms: 30000,
      signal: controller.signal,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.calls.predictions).toBe(0);
    const timeout = await predictFrozenModel({
      frozenRoot: result.directory,
      runRoot: join(root, "predictions"),
      features,
      timeout_ms: 1,
    });
    expect(timeout.status).toBe("timed_out");
    expect(client.bodies).toHaveLength(2);
    await verifyFiles(sourceRoot, [datasetBefore]);
    await verifyFiles(result.directory, [frozenIdentity]);
  }, 150000);
}
