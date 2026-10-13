import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { validateModelingTask } from "../../src/modeling/config";
import {
  csv,
  loadDataset,
  parseCsv,
  prepareDataset,
} from "../../src/modeling/data";

const task = {
  goal: "regress",
  dataset_root: "runs/data",
  image: "statigent-runtime:dev",
  model_profile: "deepseek-flash",
};
test("model artifact allowance has a usable transport frame and preserves explicitly frozen limits", () => {
  const defaults = validateModelingTask(task).limits;
  expect(defaults.max_artifact_bytes).toBe(256 * 1024 ** 2);
  expect(defaults.max_artifacts_bytes).toBe(1024 ** 3);
  expect(defaults.memory_bytes).toBe(4 * 1024 ** 3);
  for (const max of [defaults.max_artifact_bytes, 384 * 1024 ** 2]) {
    const config = validateModelingTask({
      ...task,
      limits: { max_artifact_bytes: max },
    });
    expect(config.limits.max_frame_bytes).toBeGreaterThan(
      Math.ceil(max / 3) * 4,
    );
    expect(validateModelingTask(config)).toEqual(config);
  }
  const legacy = validateModelingTask({
    ...task,
    limits: { max_artifact_bytes: 16 * 1024 ** 2, max_frame_bytes: 1024 ** 2 },
  });
  expect(legacy.limits.max_frame_bytes).toBe(1024 ** 2);
});
test("modeling rejects unsupported budgets, paths, targets and protocols before work", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "modeling-data-"));
  for (const change of [
    { metric: "accuracy" },
    { kind: "classification" },
    { target: "missing" },
    { target: "id" },
    { train: "../private.csv" },
    { split: { train: ["1"], validation: ["1"] } },
  ])
    await expect(
      prepareDataset({ ...source, ...change }, join(root, "invalid")),
    ).rejects.toThrow();
  for (const budget of [
    { training_attempts: 0 },
    { final_reserve_ms: 900000 },
    { total_tokens: -1 },
    { arbitrary: 1 },
  ])
    expect(() => validateModelingTask({ ...task, budget })).toThrow();
  expect(validateModelingTask(task).budget.final_training_attempts).toBe(1);
});
test("frozen preparation preserves inputs, exact membership and detects changes", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "modeling-data-"));
  const original = await readFile(
    join(source.input_root, source.train),
    "utf8",
  );
  const a = await prepareDataset(source, join(root, "a")),
    b = await prepareDataset(source, join(root, "b"));
  expect(a).toEqual(b);
  expect(new Set([...a.split.train, ...a.split.validation]).size).toBe(12);
  expect((await loadDataset(join(root, "a"))).dataset).toEqual(a);
  expect(await readFile(join(source.input_root, source.train), "utf8")).toBe(
    original,
  );
  await writeFile(
    join(root, "a", "dataset.json"),
    JSON.stringify({ ...a, split: { ...a.split, train: ["fake"] } }),
  );
  await expect(loadDataset(join(root, "a"))).rejects.toThrow();
  await expect(prepareDataset(source, join(root, "b"))).rejects.toThrow();
});
test("CSV round trip and malformed identity/target checks", async () => {
  const table = { columns: ["a", "b"], rows: [["x,y", 'line\n"quoted"']] };
  expect(parseCsv(csv(table))).toEqual(table);
  for (const bad of ["a,a\n1,2\n", "a,b\n1\n", 'a\n"unclosed'])
    expect(() => parseCsv(bad)).toThrow();
  const root = await mkdtemp(join(await realpath(tmpdir()), "modeling-bad-"));
  await writeFile(join(root, "test.csv"), "id,x\n9,9\n");
  for (const rows of [
    "1,1,2\n1,2,3\n3,3,4\n4,4,5\n5,5,6",
    "1,1,NaN\n2,2,3\n3,3,4\n4,4,5\n5,5,6",
  ]) {
    await writeFile(join(root, "train.csv"), `id,x,target\n${rows}\n`);
    await expect(
      prepareDataset({ ...source, input_root: root }, join(root, "out")),
    ).rejects.toThrow();
  }
});

test("quoted classification labels preserve CRLF and commas while record separators normalize", () => {
  const table = parseCsv('id,target\r\na,"A\r\nB"\r\nb,"C,D"\r\n');
  expect(table.rows).toEqual([
    ["a", "A\r\nB"],
    ["b", "C,D"],
  ]);
  expect(parseCsv(csv(table))).toEqual(table);
});
