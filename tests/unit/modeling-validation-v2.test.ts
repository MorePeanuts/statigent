import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import {
  loadDataset,
  prepareDataset,
  type Table,
} from "../../src/modeling/data";
import { DEFAULT_DATA_LIMITS } from "../../src/modeling/data-limits";
import type { DatasetV3 } from "../../src/modeling/dataset-v3";
import { createProtocolV2 } from "../../src/modeling/protocol-v2";
import { derivedSeed } from "../../src/modeling/validation";
import {
  createValidationPlanV2,
  fixedSplitV2,
} from "../../src/modeling/validation-v2";
import splitFixtures from "../fixtures/modeling-splits-v2.json";

function fixture(count = 7) {
  const p = createProtocolV2({
    kind: "multilabel",
    metric_id: "mean-target-auc-v1",
    id_column: "id",
    feature_columns: ["x"],
    targets: Array.from({ length: count }, (_, i) => ({
      name: `y${i}`,
      classes: ["01", "1"],
      positive_class: "1",
      levels: null,
    })),
  });
  const labels: Table = {
    columns: ["id", ...p.targets.map((t) => t.name)],
    rows: Array.from({ length: 160 }, (_, i) => [
      `r${i}`,
      ...p.targets.map((_, t) => ((i + t) % 2 ? "1" : "01")),
    ]),
  };
  const members = fixedSplitV2(labels, p, 17);
  const ref = (path: string) => ({ path, bytes: 1, sha256: "a".repeat(64) });
  const dataset: DatasetV3 = {
    schema_version: 3,
    protocol: p,
    limits: { ...DEFAULT_DATA_LIMITS },
    seed: 17,
    excluded_columns: [],
    training: ref("search/train.csv"),
    prediction: null,
    evaluator: {
      labels: null,
      source_rows: ref("evaluator/source-rows.jsonl"),
    },
    feature_schema: ref("search/features.json"),
    public_context: [],
    split: {
      file: ref("search/split.json"),
      method: "multilabel-hash-v1",
      train_rows: members.train.length,
      validation_rows: members.validation.length,
    },
    rows: { training: labels.rows.length, prediction: 0 },
    provenance: { benchmark: "synthetic" },
    preparation: {
      created_at: "2026-10-14T00:00:00Z",
      elapsed_ms: 0,
      reused_from: null,
    },
    dataset_sha256: "b".repeat(64),
  };
  return { dataset, labels, members };
}
test("shared TS/Python split fixture remains frozen", () => {
  for (const c of splitFixtures)
    expect(fixedSplitV2(c.labels, createProtocolV2(c.input), c.seed)).toEqual(
      c.expected,
    );
});
test("all targets share two distinct confirmation splits, invariant to source row order", () => {
  const { dataset, labels, members } = fixture();
  const reversed = { ...labels, rows: [...labels.rows].reverse() };
  expect(fixedSplitV2(reversed, dataset.protocol, 17)).toEqual(members);
  const plan = createValidationPlanV2(
    dataset,
    labels,
    members,
    "terminal_repeated_holdout",
  );
  expect(
    createValidationPlanV2(
      dataset,
      reversed,
      members,
      "terminal_repeated_holdout",
    ),
  ).toEqual(plan);
  expect(plan.confirmation).toHaveLength(2);
  expect(
    new Set([plan.search, ...plan.confirmation].map((e) => e.split.sha256))
      .size,
  ).toBe(3);
  expect(plan.search.split).toEqual(members);
  for (const e of plan.confirmation) {
    expect(e.split_method).toBe("multilabel-hash-v1");
    expect(e.split.train.length + e.split.validation.length).toBe(160);
  }
});
test("one rare target and duplicate confirmation fail without reseeding", () => {
  const { dataset, labels, members } = fixture();
  const rare = {
    ...labels,
    rows: labels.rows.map((row, i) => [
      ...row.slice(0, -1),
      i === 0 ? "1" : "01",
    ]),
  };
  expect(() => fixedSplitV2(rare, dataset.protocol, 17)).toThrow("y6/");
  const duplicate = fixedSplitV2(
    labels,
    dataset.protocol,
    derivedSeed(dataset.seed, 0, "split"),
  );
  expect(() =>
    createValidationPlanV2(
      { ...dataset, split: { ...dataset.split, method: "explicit-v1" } },
      labels,
      duplicate,
      "terminal_repeated_holdout",
    ),
  ).toThrow("no automatic reseeding");
  expect(() =>
    createValidationPlanV2(
      dataset,
      { ...labels, columns: ["id", ...labels.columns.slice(1).reverse()] },
      members,
      "none",
    ),
  ).toThrow("all targets");
});
test("new single-target splitting retains the published legacy member hash", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "split-v2-compat-")),
  );
  try {
    await prepareDataset(binary, join(root, "data"));
    const { dataset, train } = await loadDataset(join(root, "data"));
    const targetIndex = train.columns.indexOf(dataset.target),
      idIndex = train.columns.indexOf(dataset.id_column);
    const protocol = createProtocolV2({
      kind: "binary",
      metric_id: "roc-auc-v1",
      id_column: dataset.id_column,
      feature_columns: dataset.features,
      targets: [
        {
          name: dataset.target,
          classes: dataset.protocol?.classes,
          positive_class: dataset.protocol?.positive_class,
          levels: null,
        },
      ],
    });
    const labels = {
      columns: [dataset.id_column, dataset.target],
      rows: train.rows.map((row) => [
        row[idIndex] ?? "",
        row[targetIndex] ?? "",
      ]),
    };
    expect(fixedSplitV2(labels, protocol, dataset.seed)).toEqual(dataset.split);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
