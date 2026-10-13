import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import regression from "../../configs/modeling/synthetic-prepare.json";
import {
  csv,
  loadDataset,
  parseCsv,
  prepareDataset,
  validateDataset,
} from "../../src/modeling/data";
import {
  createProtocol,
  definition,
  validateProtocol,
} from "../../src/modeling/protocol";

test("fixed matrix and protocol identities reject ambiguous classifications", () => {
  for (const [kind, metric] of [
    ["regression", "rmse"],
    ["binary", "accuracy"],
    ["binary", "roc_auc"],
    ["binary", "log_loss"],
    ["multiclass", "accuracy"],
    ["multiclass", "log_loss"],
  ])
    expect(String(definition(kind, metric).metric)).toBe(String(metric));
  for (const [kind, metric] of [
    ["regression", "accuracy"],
    ["multiclass", "roc_auc"],
    ["multilabel", "accuracy"],
  ])
    expect(() => definition(kind, metric)).toThrow();
  const p = createProtocol(
    "binary",
    "roc_auc",
    ["1", "01", "1"],
    "01",
    "prediction",
  );
  expect(p.classes).toEqual(["01", "1"]);
  expect(p.prediction.column).toBe("prediction_");
  expect(validateProtocol(p, "prediction")).toEqual(p);
  for (const change of [
    { version: 2 },
    { direction: "minimize" },
    { classes: ["1", "01"] },
    { positive_class: "1" },
    { protocol_sha256: "bad" },
  ])
    expect(() => validateProtocol({ ...p, ...change }, "prediction")).toThrow();
  for (const labels of [["x"], ["x", "y", "z"], [" ", "x"]])
    expect(() =>
      createProtocol("binary", "accuracy", labels, "x", "id"),
    ).toThrow();
  expect(() =>
    createProtocol("binary", "accuracy", ["x", "y"], undefined, "id"),
  ).toThrow();
  expect(
    createProtocol("multiclass", "log_loss", ["NA", "红色", "01"], null, "id")
      .classes,
  ).toEqual(["01", "NA", "红色"]);
});

test("stratification preserves label identity and membership across row reorder", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tabular-"));
  const a = await prepareDataset(binary, join(root, "a"));
  expect(a.schema_version).toBe(2);
  expect(a.protocol?.classes).toEqual(["01", "1"]);
  expect(a.split.validation.length).toBe(12);
  const table = parseCsv(
    await readFile(join(binary.input_root, "train.csv"), "utf8"),
  );
  await writeFile(
    join(root, "train.csv"),
    csv({ ...table, rows: [...table.rows].reverse() }),
  );
  await writeFile(
    join(root, "test.csv"),
    await readFile(join(binary.input_root, "test.csv")),
  );
  const b = await prepareDataset(
    { ...binary, input_root: root },
    join(root, "b"),
  );
  expect(a.split).toEqual(b.split);
  expect((await loadDataset(join(root, "b"))).dataset).toEqual(b);
  await expect(
    prepareDataset(
      {
        ...binary,
        split: {
          train: a.split.train.concat(a.split.validation),
          validation: [],
        },
      },
      join(root, "bad"),
    ),
  ).rejects.toThrow();
  const one = table.rows.map((r, i) => [
    ...r.slice(0, 3),
    i === 0 ? "01" : "1",
  ]);
  await writeFile(join(root, "train.csv"), csv({ ...table, rows: one }));
  await expect(
    prepareDataset({ ...binary, input_root: root }, join(root, "rare")),
  ).rejects.toThrow("rare class");
  const legacy = await prepareDataset(regression, join(root, "r"));
  const { protocol: _p, split_method: _m, ...rest } = legacy;
  const old = validateDataset({ ...rest, schema_version: 1 });
  expect(old.split).toEqual(legacy.split);
  expect(old.protocol).toBeUndefined();
  expect(() => validateDataset({ ...legacy, schema_version: 42 })).toThrow();
});
