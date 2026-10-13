import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import regression from "../../configs/modeling/synthetic-prepare.json";
import { prepareDataset } from "../../src/modeling/data";
import { reproduce } from "../../src/modeling/delivery";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { obj } from "../../src/models/validation";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { baselineCode, linearCode, trainCall } from "../helpers/modeling";

for (const source of [regression, binary])
  test(`${source.kind} Docker confirmation selects the second pipeline and reproduces its frozen delivery`, async () => {
    const root = resolve("runs/integration-confirmation", randomUUID());
    await mkdir(root, { recursive: true });
    await prepareDataset(source, join(root, "data"));
    // Deliberate seed sensitivity is a deterministic protocol probe, not a research model.
    const first =
      source.kind === "regression"
        ? linearCode
            .replace(
              "return make_pipeline(",
              "return DummyRegressor(strategy='constant', constant=1000) if seed != 42 else make_pipeline(",
            )
            .replace(
              "from sklearn.compose",
              "from sklearn.dummy import DummyRegressor\nfrom sklearn.compose",
            )
        : "from sklearn.dummy import DummyClassifier\nfrom sklearn.tree import DecisionTreeClassifier\ndef build_pipeline(seed):\n    return DecisionTreeClassifier(random_state=seed) if seed == 42 else DummyClassifier(strategy='prior')\n";
    const second =
      source.kind === "regression"
        ? baselineCode
        : "from sklearn.compose import ColumnTransformer\nfrom sklearn.pipeline import make_pipeline\nfrom sklearn.linear_model import LogisticRegression\ndef build_pipeline(seed):\n    return make_pipeline(ColumnTransformer([('x','passthrough',['x'])]),LogisticRegression(random_state=seed))\n";
    const client = new ScriptClient((body, i) =>
      reply(
        i === 0
          ? [trainCall(first, [], null, { candidateId: "first" })]
          : i === 1
            ? [trainCall(second, [], null, { candidateId: "second" })]
            : [
                call("finish_modeling", {
                  candidate_updates: [],
                  experiment_id: lastFeedback(body).best_experiment_id,
                  reason: "Freeze for confirmation",
                }),
              ],
      ),
    );
    const result = await runModeling({
      task: {
        schema_version: 2,
        method: "no_eda",
        confirmation: { mode: "terminal_repeated_holdout" },
        resource_version: "confirmation-test-v1",
        goal: "Validate frozen selection",
        dataset_root: join(root, "data"),
        model_profile: profile.id,
        image: "statigent-runtime:dev",
        budget: {
          training_attempts: 7,
          task_timeout_ms: 1200000,
          final_reserve_ms: 750000,
        },
      },
      profile,
      edaProfile: profile,
      runRoot: root,
      client,
    });
    expect(result.status, result.reason).toBe("completed");
    const view = await inspectModeling(result.directory),
      m = view.manifest,
      delivery = obj(m.delivery);
    expect(client.bodies).toHaveLength(3);
    expect(obj(m.confirmation).status).toBe("complete");
    expect(m.search_best_experiment_id).not.toBe(m.selected_experiment_id);
    expect(delivery.schema_version).toBe(3);
    expect(delivery.source_experiment).toBe(m.selected_experiment_id);
    const experiments = (m.experiments as unknown[]).map(obj);
    expect(experiments.filter((e) => e.phase === "confirmation")).toHaveLength(
      4,
    );
    expect(experiments.find((e) => e.final)?.code).toBe(second);
    for (const mode of ["predict", "refit"] as const)
      expect(
        (await reproduce(result.directory, join(root, "reproductions"), mode))
          .status,
      ).toBe("passed");
    const parentPath = join(result.directory, "modeling.json"),
      deliveryPath = join(result.directory, "delivery/delivery.json"),
      parentBytes = await Bun.file(parentPath).text(),
      deliveryBytes = await Bun.file(deliveryPath).text();
    for (const key of [
      "search_best_score",
      "selected_experiment_id",
      "confirmation",
      "validation_plan",
      "dataset",
    ]) {
      const parent = JSON.parse(parentBytes),
        delivery = JSON.parse(deliveryBytes);
      delete delivery[key];
      parent.delivery = delivery;
      await Bun.write(parentPath, JSON.stringify(parent));
      await Bun.write(deliveryPath, JSON.stringify(delivery));
      await expect(
        reproduce(result.directory, join(root, "invalid-reproductions")),
      ).rejects.toThrow();
    }
    await Bun.write(parentPath, parentBytes);
    await Bun.write(deliveryPath, deliveryBytes);
  }, 240000);
