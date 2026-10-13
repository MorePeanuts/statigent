import { expect, test } from "bun:test";
import selection from "../../benchmarks/metadata/ds-modeling-selection.json";
import catalog from "../../benchmarks/metadata/modeling-task-catalog.json";
import tabarena from "../../benchmarks/metadata/tabarena-tasks.json";
import {
  assertCatalogCoverage,
  parseModelingCatalog,
} from "../../src/evaluation/benchmarks/modeling/catalog";

test("catalog retains all 52 DSBench and 51 TabArena candidate identities", () => {
  const parsed = parseModelingCatalog(catalog);
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
