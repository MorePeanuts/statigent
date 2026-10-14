import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describeFile, verifyFiles } from "../../src/evaluation/files";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { reproduce, scoreDelivery } from "../../src/modeling/delivery";
import { predictionDeliveryV5 } from "../../src/modeling/delivery-v2";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { call, profile, reply, ScriptClient } from "../helpers/agent";

for (const kind of ["ordinal", "multiclass", "multilabel"] as const) {
  test(`native ${kind}: independent prediction/refit reproduction and test scoring without native models`, async () => {
    const root = resolve(
      "runs/integration-modeling-reproduction-v2",
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
        "from pathlib import Path; import sys; from test_modeling_runner_v4 import fixture; fixture(Path(sys.argv[1]),sys.argv[2],int(sys.argv[3]),True)",
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
    const sourceRoot = join(root, "prepared"),
      sourceIdentity = await describeFile(sourceRoot, "dataset.json");
    const code = `from sklearn.tree import DecisionTreeClassifier\nfrom sklearn.multioutput import MultiOutputClassifier\ndef build_pipeline(seed):\n    return ${kind === "multilabel" ? "MultiOutputClassifier(DecisionTreeClassifier(random_state=seed))" : "DecisionTreeClassifier(random_state=seed)"}\n`;
    const client = new ScriptClient((_body, index) => {
      if (index === 0)
        return reply([
          call("run_experiment", {
            code,
            change: "fixed tree",
            reason: "synthetic verification",
          }),
        ]);
      if (index === 1)
        return reply([
          call("finish_modeling", { reason: "fixed verification complete" }),
        ]);
      throw new Error("No extra model calls");
    });
    const result = await runModeling({
      task: {
        schema_version: 4,
        delivery_mode: "fit_predict",
        method: "no_eda",
        confirmation: { mode: "none" },
        resource_version: "synthetic-reproduction-v2",
        goal: "Test reproducible target semantics",
        dataset_root: sourceRoot,
        model_profile: profile.id,
        image: "statigent-runtime:modeling-benchmarks",
      },
      profile,
      edaProfile: profile,
      client,
      runRoot: root,
    });
    expect(result.status, result.reason).toBe("completed");
    const parentIdentity = await describeFile(
      result.directory,
      "modeling.json",
    );
    const inspected = await inspectModeling(result.directory);
    expect(inspected.unconfirmed_children).toHaveLength(0);
    if (kind === "multilabel") {
      const path = join(result.directory, "modeling.json"),
        bytes = await readFile(path);
      try {
        for (const mutation of ["target", "aggregate"]) {
          const changed = JSON.parse(bytes.toString());
          const score = changed.experiments.find(
            (e: { score: unknown }) => e.score,
          )?.score;
          if (!score) throw new Error("Missing score fixture");
          if (mutation === "target") score.components.reverse();
          else score.value = 0.25;
          await writeFile(path, JSON.stringify(changed));
          await expect(inspectModeling(result.directory)).rejects.toThrow();
        }
      } finally {
        await writeFile(path, bytes);
      }
    }
    for (const mode of ["predict", "refit"] as const) {
      const reproduced = await reproduce(
        result.directory,
        join(root, "reproductions"),
        mode,
      );
      expect(reproduced.status, reproduced.reason).toBe("passed");
      expect(reproduced.tokens).toBe("not_applicable");
    }
    const scored = await scoreDelivery(
      result.directory,
      sourceRoot,
      "evaluator/labels.csv",
      join(root, "scores"),
    );
    expect(scored.score?.value).toBe(1);
    if (!scored.score || !("partition" in scored.score))
      throw new Error("Missing versioned score");
    expect(scored.score.partition).toBe("test");
    const scoreIdentity = await describeFile(scored.directory, "score.json");
    const published = await predictionDeliveryV5(result.directory);
    const hidden = join(root, "withheld-native-model-stages");
    await rename(join(result.directory, "stages"), hidden);
    try {
      const rescored = await scoreDelivery(
        result.directory,
        sourceRoot,
        "evaluator/labels.csv",
        join(root, "scores"),
      );
      expect(rescored.score).toEqual(scored.score);
      const path = published.predictions.path,
        bytes = await readFile(path);
      await chmod(path, 0o644);
      try {
        await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
        const corrupted = await scoreDelivery(
          result.directory,
          sourceRoot,
          "evaluator/labels.csv",
          join(root, "scores"),
        );
        expect(corrupted.score).toBeNull();
        expect("error" in corrupted && corrupted.error).toContain("integrity");
      } finally {
        await writeFile(path, bytes);
        await chmod(path, 0o444);
      }
    } finally {
      await rename(hidden, join(result.directory, "stages"));
    }
    expect(client.bodies).toHaveLength(2);
    await verifyFiles(sourceRoot, [sourceIdentity]);
    await verifyFiles(result.directory, [parentIdentity]);
    await verifyFiles(scored.directory, [scoreIdentity]);
  }, 180000);
}
