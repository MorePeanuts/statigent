import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import multi from "../../configs/modeling/multiclass-prepare.json";
import source from "../../configs/modeling/synthetic-prepare.json";
import { loadDataset, prepareDataset } from "../../src/modeling/data";
import {
  createValidationPlan,
  derivedSeed,
} from "../../src/modeling/validation";

for (const config of [source, binary, multi])
  test(`frozen extra splits preserve original data, reorder deterministically and cover ${config.kind}`, async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "validation-plan-"),
    );
    await prepareDataset(config, join(root, "data"));
    const { dataset, train } = await loadDataset(join(root, "data"));
    const before = await readFile(join(root, "data/dataset.json"), "utf8");
    const plan = createValidationPlan(
      dataset,
      train,
      "terminal_repeated_holdout",
    );
    expect(plan.confirmation).toHaveLength(2);
    expect(
      createValidationPlan(
        dataset,
        { ...train, rows: [...train.rows].reverse() },
        "terminal_repeated_holdout",
      ),
    ).toEqual(plan);
    expect(plan.confirmation[0]?.model_seed).toBe(
      derivedSeed(dataset.seed, 0, "model"),
    );
    expect(
      new Set([
        plan.search.split.sha256,
        ...plan.confirmation.map((e) => e.split.sha256),
      ]).size,
    ).toBe(3);
    for (const e of plan.confirmation) {
      expect(new Set([...e.split.train, ...e.split.validation]).size).toBe(
        train.rows.length,
      );
      if (dataset.protocol?.classes.length)
        for (const members of [e.split.train, e.split.validation]) {
          const labels = new Set(
            train.rows
              .filter((r) =>
                members.includes(
                  r[train.columns.indexOf(dataset.id_column)] ?? "",
                ),
              )
              .map((r) => r[train.columns.indexOf(dataset.target)]),
          );
          expect(labels.size).toBe(dataset.protocol.classes.length);
        }
    }
    expect(await readFile(join(root, "data/dataset.json"), "utf8")).toBe(
      before,
    );
    expect(createValidationPlan(dataset, train, "none").confirmation).toEqual(
      [],
    );
  });

test("infeasible repeated splits reject without trying new random seeds", async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "validation-small-"),
  );
  await prepareDataset(binary, join(root, "data"));
  const { dataset, train } = await loadDataset(join(root, "data"));
  const t = { ...train, rows: train.rows.slice(0, 1) };
  expect(() =>
    createValidationPlan(dataset, t, "terminal_repeated_holdout"),
  ).toThrow("membership");
  const plan = createValidationPlan(
    dataset,
    train,
    "terminal_repeated_holdout",
  );
  const first = plan.confirmation[0];
  if (!first) throw new Error("fixture");
  expect(() =>
    createValidationPlan(
      { ...dataset, split: first.split },
      train,
      "terminal_repeated_holdout",
    ),
  ).toThrow("duplicates");
});
