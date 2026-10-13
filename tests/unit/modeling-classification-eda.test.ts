import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import {
  csv,
  datasetProtocol,
  loadDataset,
  parseCsv,
  prepareDataset,
  select,
} from "../../src/modeling/data";
import {
  type AnalysisRecord,
  prepareAnalysisInput,
  validateEvidence,
} from "../../src/modeling/eda";
import type { Experiment } from "../../src/modeling/experiments";
import { obj } from "../../src/models/validation";
import { emptyLedger } from "../../src/records/agent-metadata";
import { sha256 } from "../../src/records/store";

async function fixture() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "classification-eda-"),
  );
  await prepareDataset(binary, join(root, "data"));
  const loaded = await loadDataset(join(root, "data"));
  const { dataset } = loaded;
  const protocol = datasetProtocol(dataset),
    rows = dataset.split.validation.map((id) => [id, "01", "0.6", "0.4"]);
  const bytes = Buffer.from(
    csv({
      columns: [
        "id",
        protocol.prediction.column,
        ...protocol.prediction.probability_columns,
      ],
      rows: rows.reverse(),
    }),
  );
  await mkdir(join(root, "stage", "artifacts"), { recursive: true });
  await writeFile(join(root, "stage", "artifacts", "predictions.csv"), bytes);
  const experiment: Experiment = {
    id: "e",
    candidate_id: "c",
    code: "",
    code_sha256: "a".repeat(64),
    status: "completed",
    reason: "ok",
    score: null,
    fit: null,
    final: false,
    predict: {
      run_id: "p",
      directory: join(root, "stage"),
      status: "completed",
      reason: "ok",
      output: {
        path: "artifacts/predictions.csv",
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
      image: { id: "image", platform: "linux/arm64" },
      elapsed_ms: 0,
    },
  };
  return { root, ...loaded, experiment };
}
test("EDA snapshot preserves literal targets, aligns by ID and avoids feature name collisions", async () => {
  const o = await fixture();
  const train = {
    columns: [...o.train.columns, "__prediction", "__probability_0"],
    rows: o.train.rows.map((r) => [...r, "keep", "keep-prob"]),
  };
  const input = join(o.root, "input");
  await prepareAnalysisInput(input, o.dataset, train, o.experiment);
  expect((await readdir(input)).sort()).toEqual([
    "context.json",
    "source.json",
    "split.json",
    "train.csv",
    "validation.csv",
  ]);
  const source = JSON.parse(await readFile(join(input, "source.json"), "utf8"));
  expect(source.fields.prediction).toBe("__prediction_");
  expect(source.fields.probabilities[0]).toEqual({
    column: "__probability_0_",
    label: "01",
  });
  expect(source.prediction_sha256).toBe(o.experiment.predict?.output?.sha256);
  const table = parseCsv(await readFile(join(input, "validation.csv"), "utf8"));
  expect(table.rows.map((r) => r[0])).toEqual(o.dataset.split.validation);
  expect(table.rows.map((r) => r[3])).toEqual(
    select(o.train, o.dataset.split.validation, "id").rows.map((r) => r[3]),
  );
  const pure = join(o.root, "pure");
  await prepareAnalysisInput(pure, o.dataset, o.train, null);
  expect(
    JSON.parse(await readFile(join(pure, "source.json"), "utf8")),
  ).toMatchObject({ prediction_sha256: null, fields: null });
});
test("invalid predictions cannot be published to EDA, and evidence binds protocol, source and prediction identity", async () => {
  const o = await fixture();
  if (!o.experiment.predict?.output) throw Error("fixture");
  const a: AnalysisRecord = {
    id: "a",
    run_id: "a",
    source_experiment: "e",
    dataset_hash: o.dataset.files[0]?.sha256 ?? "",
    split_hash: o.dataset.split.sha256,
    protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
    prediction_sha256: o.experiment.predict.output.sha256,
    status: "completed",
    reason: "ok",
    analysis: {
      summary: "x",
      findings: [{ statement: "f", evidence_refs: ["ref"] }],
      methods: [],
      limitations: [],
    },
    directory: null,
    cost: emptyLedger(),
    role_usage: { planner: emptyLedger(), executor: emptyLedger() },
    executions: 0,
    request: {
      kind: "analyze",
      candidate_updates: [],
      candidates: ["c"],
      question: "q",
      expected_evidence: "e",
      purpose: "diagnose",
      source_experiments: ["e"],
    },
  };
  const use = {
    analysis_id: "a",
    source_experiment: "e",
    refs: ["ref"],
    applicability: "same",
  };
  expect(() =>
    validateEvidence([use], [a], o.dataset, [o.experiment]),
  ).not.toThrow();
  for (const changed of [
    { protocol_sha256: "wrong" },
    { prediction_sha256: "wrong" },
    { source_experiment: "other" },
  ])
    expect(() =>
      validateEvidence([use], [{ ...a, ...changed }], o.dataset, [
        o.experiment,
      ]),
    ).toThrow();
  const bytes = Buffer.from(
    "id,prediction,probability_0,probability_1\na,01,-1,2\n",
  );
  await writeFile(
    join(o.experiment.predict.directory, "artifacts", "predictions.csv"),
    bytes,
  );
  o.experiment.predict.output = {
    path: "artifacts/predictions.csv",
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
  const input = join(o.root, "bad-input");
  await expect(
    prepareAnalysisInput(input, o.dataset, o.train, o.experiment),
  ).rejects.toThrow();
  expect(await readdir(input)).not.toContain("validation.csv");
  expect(await readdir(input)).not.toContain("source.json");
  expect(obj(a).prediction_sha256).not.toBe(o.experiment.predict.output.sha256);
});

test("two model snapshots preserve aligned IDs and separate provenance; invalid paths/hashes reject", async () => {
  const o = await fixture(),
    second = { ...o.experiment, id: "e2" },
    input = join(o.root, "compare");
  await prepareAnalysisInput(
    input,
    o.dataset,
    o.train,
    [o.experiment, second],
    { question: "Compare errors", knowledge: { entries: [], omitted: [] } },
  );
  const source = obj(
    JSON.parse(await readFile(join(input, "source.json"), "utf8")),
  );
  expect(source.sources).toHaveLength(2);
  for (const id of ["e", "e2"]) {
    const table = parseCsv(
      await readFile(join(input, `validation-${id}.csv`), "utf8"),
    );
    expect(table.rows.map((r) => r[0])).toEqual(o.dataset.split.validation);
  }
  await expect(
    prepareAnalysisInput(join(o.root, "escape"), o.dataset, o.train, [
      { ...second, id: "../private" },
    ]),
  ).rejects.toThrow("identity");
  if (!second.predict?.output) throw new Error("fixture");
  second.predict = {
    ...second.predict,
    output: { ...second.predict.output, sha256: "f".repeat(64) },
  };
  await expect(
    prepareAnalysisInput(join(o.root, "bad-hash"), o.dataset, o.train, [
      o.experiment,
      second,
    ]),
  ).rejects.toThrow();
});
