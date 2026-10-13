import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { validateRecordedModelingTask } from "../../src/modeling/config";
import {
  datasetProtocol,
  loadDataset,
  prepareDataset,
} from "../../src/modeling/data";
import { inspectModeling, ModelingRecord } from "../../src/modeling/records";
import { createValidationPlan } from "../../src/modeling/validation";
import { sha256 } from "../../src/records/store";

test("historical schema 3 failed record retains candidate/knowledge semantics and bytes", async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "modeling-history-"),
  );
  await prepareDataset(source, join(root, "data"));
  const { dataset, train } = await loadDataset(join(root, "data"));
  const task = validateRecordedModelingTask({
    schema_version: 2,
    method: "collaborative",
    confirmation: { mode: "none" },
    resource_version: "old",
    goal: "predict",
    dataset_root: join(root, "data"),
    model_profile: "test",
    image: "test",
  });
  const plan = createValidationPlan(dataset, train, "none"),
    bytes = JSON.stringify(plan);
  const record = await ModelingRecord.create(
    root,
    {
      task,
      dataset,
      protocol: datasetProtocol(dataset),
      prompt: { version: "modeling-v6" },
      validation_plan: plan,
      validation_plan_sha256: sha256(Buffer.from(bytes)),
    },
    1000000,
  );
  await writeFile(join(record.directory, "validation-plan.json"), bytes);
  await record.event("run_started");
  await record.save({
    status: "failed",
    basic_profile: null,
    candidate_control: { version: 1, candidates: [], applied_sequence: 0 },
    knowledge_control: { version: 1, history: [], applied_sequence: 0 },
    experiments: [],
    analyses: [],
    best_experiment_id: null,
    search_best_experiment_id: null,
    selected_experiment_id: null,
    confirmation: null,
  });
  const path = join(record.directory, "modeling.json"),
    before = await readFile(path);
  const view = await inspectModeling(record.directory);
  expect(view.manifest.schema_version).toBe(3);
  expect(view.knowledge_control).toEqual({
    version: 1,
    history: [],
    applied_sequence: 0,
  });
  expect(view.manifest.search_end).toBeUndefined();
  expect(view.manifest.notes_control).toBeUndefined();
  expect(sha256(await readFile(path))).toBe(sha256(before));
  for (const version of [4, "3", 5]) {
    const changed = JSON.parse(before.toString());
    changed.schema_version = version;
    await writeFile(path, JSON.stringify(changed));
    await expect(inspectModeling(record.directory)).rejects.toThrow();
  }
});
