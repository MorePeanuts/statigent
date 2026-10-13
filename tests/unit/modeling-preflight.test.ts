import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import task from "../../configs/modeling/synthetic.json";
import source from "../../configs/modeling/synthetic-prepare.json";
import { modelingMain } from "../../src/modeling/cli";
import { MODELING_METHODS } from "../../src/modeling/config";
import { prepareDataset } from "../../src/modeling/data";
import {
  modelingPreflight,
  taskWithResource,
} from "../../src/modeling/preflight";
import { obj } from "../../src/models/validation";

test("four development methods share data, confirmation and resources; preflight does no training or model calls", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "preflight-"));
  await prepareDataset(source, join(root, "data"));
  const resource = "configs/modeling/resources/workflow-dev-v1.json";
  const views = [];
  for (const method of MODELING_METHODS) {
    const configured = await taskWithResource(
      { ...task, dataset_root: join(root, "data"), method },
      resource,
    );
    const path = join(root, `${method}.json`);
    await Bun.write(path, JSON.stringify(configured));
    const before = await Bun.file(join(root, "data/dataset.json")).text();
    const view = obj(
      await modelingMain([
        "run",
        "--task",
        path,
        "--seed",
        "42",
        "--preflight",
      ]),
    );
    expect(view.calls).toEqual({ models: 0, training: 0 });
    expect(view.reserve).toMatchObject({
      training_attempts: 5,
      search_attempts: null,
      confirmation_attempts: 4,
    });
    expect(view.tools).toHaveLength(
      ["no_eda", "initial_eda"].includes(method) ? 2 : 3,
    );
    expect(await Bun.file(join(root, "data/dataset.json")).text()).toBe(before);
    views.push({
      dataset: view.dataset,
      plan: view.validation_plan_sha256,
      budget: obj(view.task).budget,
      model: obj(view.task).model_profile,
    });
    await expect(modelingPreflight(configured, 43)).rejects.toThrow(
      "frozen dataset",
    );
  }
  expect(new Set(views.map((v) => JSON.stringify(v))).size).toBe(1);
});

test("development requires one explicit known task and resource scope before any work", async () => {
  for (const args of [
    ["develop"],
    [
      "develop",
      "--task",
      "all",
      "--method",
      "collaborative",
      "--seed",
      "42",
      "--resource",
      "missing",
    ],
    ["develop", "--task", "binary", "--preflight"],
    ["develop", "--task", "binary", "--preflight", "--preflight"],
  ])
    await expect(modelingMain(args)).rejects.toThrow();
});
