import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reproduce } from "../../src/modeling/delivery";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { integer, obj } from "../../src/models/validation";
import { call, profile, reply, ScriptClient } from "../helpers/agent";
import { preparedModelingTask } from "../helpers/evaluation-modeling";

test("V2 truncated response retains confirmation, derived seeds, final fitting and independent prediction reproduction", async () => {
  const root = resolve("runs/integration-modeling-length-v2", randomUUID());
  await mkdir(root, { recursive: true });
  await preparedModelingTask(root);
  const code = `from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.tree import DecisionTreeClassifier
from sklearn.multioutput import MultiOutputClassifier
def build_pipeline(seed):
    return Pipeline([('features',ColumnTransformer([('signal','passthrough',['signal'])])),('model',MultiOutputClassifier(DecisionTreeClassifier(random_state=(int(seed) * 10 + 1000) % (2**32))))])
`;
  const client = new ScriptClient((_body, index) => {
    if (index === 0)
      return reply([
        call("run_experiment", {
          code,
          change: "fixed tree",
          reason: "synthetic regression test",
        }),
      ]);
    if (index === 1)
      return reply(undefined, {
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "partial reasoning",
              tool_calls: [call("run_experiment", '{"code":"PARTIAL')],
            },
          },
        ],
      });
    throw Error("No new model calls after truncated response");
  });
  const result = await runModeling({
    task: {
      schema_version: 4,
      delivery_mode: "fit_predict",
      method: "no_eda",
      confirmation: { mode: "terminal_repeated_holdout" },
      budget: {
        training_attempts: 6,
        task_timeout_ms: 1200000,
        final_reserve_ms: 750000,
      },
      resource_version: "length-recovery-v1",
      goal: "Predict every target",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:modeling-benchmarks",
    },
    profile,
    edaProfile: profile,
    client,
    runRoot: root,
  });
  expect(result.status, result.reason).toBe("completed");
  expect(client.bodies).toHaveLength(2);
  const view = await inspectModeling(result.directory);
  expect(view.manifest.schema_version).toBe(5);
  expect(view.manifest.search_end).toEqual({
    kind: "protected",
    reason: "response_length",
  });
  expect(view.manifest.usage).toMatchObject({
    tokens: { status: "known", attempts: 2 },
    training_attempts: 4,
    confirmation_training_attempts: 2,
  });
  expect(view.manifest.confirmation).toMatchObject({ status: "complete" });
  if (!Array.isArray(view.manifest.experiments))
    throw Error("Missing experiments");
  const confirmationSeeds = view.manifest.experiments
    .map(obj)
    .filter((experiment) => experiment.phase === "confirmation")
    .map((experiment) =>
      integer(obj(experiment.evaluation).model_seed, "model_seed", 0),
    );
  expect(confirmationSeeds).toHaveLength(2);
  expect(confirmationSeeds.some((seed) => seed * 10 + 1000 > 4294967295)).toBe(
    true,
  );
  expect(view.unconfirmed_children).toHaveLength(0);
  expect(view.unconfirmed_experiments).toHaveLength(0);
  expect(
    (await reproduce(result.directory, join(root, "reproductions"))).status,
  ).toBe("passed");
}, 180000);
