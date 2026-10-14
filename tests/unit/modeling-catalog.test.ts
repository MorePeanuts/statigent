import { expect, test } from "bun:test";
import selection from "../../benchmarks/metadata/ds-modeling-selection.json";
import catalog from "../../benchmarks/metadata/modeling-task-catalog.json";
import tabarena from "../../benchmarks/metadata/tabarena-tasks.json";
import { parseAuditOptions } from "../../src/evaluation/benchmarks/modeling/audit";
import {
  assertCatalogCoverage,
  parseModelingCatalog,
} from "../../src/evaluation/benchmarks/modeling/catalog";
import { main } from "../../src/evaluation/cli";

test("catalog retains all 52 DSBench and 51 TabArena candidate identities", () => {
  const parsed = parseModelingCatalog(catalog);
  expect(parsed as unknown).toEqual(catalog);
  expect(Object.keys(parsed.tasks[0] ?? {})).toEqual([
    "benchmark",
    "task_id",
    "source_revision",
    "code_revision",
    "openml",
    "files",
    "outer_split",
    "protocol",
    "issues",
    "research",
    "adaptation",
    "acceptance",
  ]);
  expect(parsed.tasks.length).toBe(103);
  assertCatalogCoverage(parsed, {
    "dsbench-modeling": selection.included,
    "tabarena-lite": tabarena.map((item) => item.task_id),
  });
  expect(() =>
    assertCatalogCoverage(
      { ...parsed, tasks: parsed.tasks.slice(1) },
      {
        "dsbench-modeling": selection.included,
        "tabarena-lite": tabarena.map((item) => item.task_id),
      },
    ),
  ).toThrow("missing=");
});

test("catalog rejects unknown nested fields and keeps protocol checks", () => {
  const task = catalog.tasks.find((item) => item.protocol !== null);
  expect(task).toBeDefined();
  const protocol = task?.protocol;
  if (!task || !protocol) throw new Error("Missing protocol fixture");
  for (const changed of [
    { ...task, files: [{ ...task.files[0], hidden: true }] },
    {
      ...task,
      protocol: {
        ...protocol,
        identity: { ...protocol.identity, hidden: true },
      },
    },
    {
      ...task,
      protocol: {
        ...protocol,
        feature_columns: [...protocol.feature_columns, ...protocol.targets],
      },
    },
  ])
    expect(() =>
      parseModelingCatalog({ schema_version: 1, tasks: [changed] }),
    ).toThrow();
});

test("audit CLI accepts explicit options and rejects repeats or unknown flags", () => {
  expect(parseAuditOptions([])).toEqual({});
  expect(
    parseAuditOptions(["--data-root", "benchmarks", "--output", "audit.json"]),
  ).toEqual({ dataRoot: "benchmarks", output: "audit.json" });
  for (const args of [
    ["--catalog"],
    ["--catalog="],
    ["--data-root", "benchmarks", "--data-root", "other"],
    ["--data-root", "--catalog", "file.json"],
    ["--models", "models.json"],
    ["unexpected"],
  ])
    expect(() => parseAuditOptions(args)).toThrow("evaluate audit");
});

test("missing fields, duplicate identities, unknown versions and states are rejected", () => {
  const task = catalog.tasks[0];
  expect(() =>
    parseModelingCatalog({ schema_version: 2, tasks: [] }),
  ).toThrow();
  expect(() =>
    parseModelingCatalog({ schema_version: 1, tasks: [task, task] }),
  ).toThrow("Duplicate");
  for (const field of Object.keys(task ?? {})) {
    const broken: Record<string, unknown> = { ...task };
    delete broken[field];
    expect(() =>
      parseModelingCatalog({ schema_version: 1, tasks: [broken] }),
    ).toThrow();
  }
  for (const update of [
    { research: { status: "passed", reasons: [] } },
    { adaptation: { status: "ready", reasons: ["unresolved"] } },
    {
      acceptance: {
        preflight: { status: "passed", evidence: [] },
        deterministic: { status: "not_run", evidence: [] },
        live: { status: "not_run", evidence: [] },
      },
    },
    {
      files: [
        {
          path: "../private.csv",
          sha256: "0".repeat(64),
          bytes: 0,
          access: "raw",
        },
      ],
    },
  ])
    expect(() =>
      parseModelingCatalog({
        schema_version: 1,
        tasks: [{ ...task, ...update }],
      }),
    ).toThrow();
});

test("research, adaptation and acceptance are independent and require evidence", () => {
  const parsed = parseModelingCatalog({
    schema_version: 1,
    tasks: [
      {
        ...catalog.tasks[0],
        research: { status: "excluded", reasons: ["time semantics"] },
        acceptance: {
          preflight: { status: "passed", evidence: ["runs/audit.json"] },
          deterministic: { status: "not_run", evidence: [] },
          live: { status: "not_run", evidence: [] },
        },
      },
    ],
  });
  expect(parsed.tasks[0]?.research.status).toBe("excluded");
  expect(parsed.tasks[0]?.adaptation.status).toBe("blocked");
  expect(parsed.tasks[0]?.acceptance.live.status).toBe("not_run");
});

test("audit rejects model-call and run options before doing any work", async () => {
  for (const args of [
    ["--allow-model-calls"],
    ["--models", "config.json"],
    ["--output"],
    ["--data-root", "benchmarks", "--data-root", "other"],
  ]) {
    await expect(main(["audit", ...args])).rejects.toThrow("evaluate audit");
  }
});
