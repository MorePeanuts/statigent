import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { command, commandEnvironment } from "../../src/evaluation/process";
import {
  DEFAULT_DATA_LIMITS,
  parseDataLimits,
} from "../../src/modeling/data-limits";
import { loadDatasetV3, parseDatasetV3 } from "../../src/modeling/dataset-v3";
import { canonicalJson } from "../../src/modeling/protocol-v2";
import { sha256 } from "../../src/records/store";

const temporary = await mkdtemp(resolve(tmpdir(), "statigent-data-v3-"));
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});
test("trusted dataset loader returns descriptors and verifies Python/TS manifest identity", async () => {
  const root = resolve(temporary, "prepared");
  const script = `
from pathlib import Path
import sys
from statigent_modeling.data_v3 import prepare_rows
from statigent_modeling.limits import DEFAULT_DATA_LIMITS
prepare_rows(Path(sys.argv[1]),kind="regression",metric_id="mae-v1",id_column="id",
targets=[dict(name="y",classes=[],positive_class=None,levels=None)],
features=[dict(name="x",kind="numeric",source_type="synthetic",categories=None)],
excluded_columns=[],train=((str(i),i,dict(x=i,y=i)) for i in range(20)),
prediction=None,labels=None,seed=17,limits=DEFAULT_DATA_LIMITS,provenance={"benchmark":"synthetic"})
`;
  await command(
    [
      "uv",
      "run",
      "--offline",
      "--frozen",
      "--no-sync",
      "python",
      "-c",
      script,
      root,
    ],
    {
      timeout_ms: 10000,
      env: { ...commandEnvironment(), PYTHONPATH: resolve("python") },
    },
  );
  const loaded = await loadDatasetV3(root);
  expect(loaded.dataset.rows).toEqual({ training: 20, prediction: 0 });
  expect(loaded.dataset.protocol.metric.id).toBe("mae-v1");
  expect(loaded.dataset.prediction).toBeNull();
  expect(loaded.dataset.training.path).toBe("search/train.csv");
  const raw: unknown = await Bun.file(resolve(root, "dataset.json")).json();
  expect(parseDatasetV3(raw)).toEqual(loaded.dataset);
  await expect(
    loadDatasetV3(root, {
      limits: { ...DEFAULT_DATA_LIMITS, max_file_bytes: 100 },
    }),
  ).rejects.toThrow();
  const changed = {
    ...loaded.dataset,
    training: { ...loaded.dataset.training, path: "evaluator/labels.csv" },
  };
  const { dataset_sha256: _, ...content } = changed;
  changed.dataset_sha256 = sha256(Buffer.from(canonicalJson(content)));
  expect(() => parseDatasetV3(changed)).toThrow("partition file reference");
  expect(() => parseDatasetV3({ ...loaded.dataset, seed: 18 })).toThrow(
    "manifest hash",
  );
});
test("shared data limits reject missing, zero and extra dimensions", () => {
  expect(parseDataLimits(DEFAULT_DATA_LIMITS)).toEqual(DEFAULT_DATA_LIMITS);
  for (const bad of [
    { ...DEFAULT_DATA_LIMITS, max_rows: 0 },
    { ...DEFAULT_DATA_LIMITS, max_file_bytes: undefined },
    { ...DEFAULT_DATA_LIMITS, unbounded: true },
  ])
    expect(() => parseDataLimits(bad)).toThrow();
});
