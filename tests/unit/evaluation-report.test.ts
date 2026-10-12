import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "../../src/evaluation/plan";
import { createReport, csv, rescore } from "../../src/evaluation/report";
import { runEvaluation } from "../../src/evaluation/run";
import { config, fixtureRegistry, submission } from "../helpers/evaluation";

test("reports preserve original execution and scoring while rescoring uses no agent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reports-")));
  let calls = 0;
  try {
    await writeFile(join(root, "data.csv"), "value\n1\n2\n");
    const registry = fixtureRegistry(root, async (i) => {
      calls++;
      return {
        ...submission(i.unit_id),
        status: calls === 1 ? "failed" : "completed",
      };
    });
    const result = await runEvaluation(
      await buildPlan(config(), registry),
      registry,
      join(root, "runs"),
      { environment: {} },
    );
    const original = await createReport(result.directory, registry);
    expect(original.report.groups[0]?.metrics).toEqual({ accuracy: 0.5 });
    expect(original.report.rows).toHaveLength(2);
    const recordPath = join(result.directory, "units/unit-000001/record.json");
    const originalRecord = await readFile(recordPath, "utf8");
    const before = await readFile(
      join(original.directory, "report.json"),
      "utf8",
    );
    const benchmark = registry.getBenchmark("synthetic");
    const catalog = benchmark.catalog;
    benchmark.catalog = async (options) => {
      const value = await catalog(options);
      return {
        ...value,
        tasks: value.tasks.map((t) => ({
          ...t,
          inputs: t.inputs.map((f) => ({
            bytes: f.bytes,
            path: f.path,
            sha256: f.sha256,
          })),
        })),
      };
    };
    const next = await rescore(result.directory, registry);
    expect(next.score_id).not.toBe(original.score_id);
    expect(next.report.groups[0]?.metrics).toEqual({ accuracy: 0.5 });
    expect(calls).toBe(2);
    expect(await readFile(recordPath, "utf8")).toBe(originalRecord);
    expect(
      await readFile(join(original.directory, "report.json"), "utf8"),
    ).toBe(before);
    const path = join(result.directory, "units/unit-000001/submission.json");
    await chmod(path, 0o600);
    await writeFile(path, "{}");
    await expect(rescore(result.directory, registry)).rejects.toThrow(
      "integrity",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("CSV quotes newlines and quotes, and neutralizes spreadsheet formulas", () => {
  expect(csv([{ name: 'a,"b"\nc', reason: "=1+1", metric: 0.5 }])).toContain(
    '"a,""b""\nc"',
  );
  expect(csv([{ answer: "@sum[3]" }])).toContain("'@sum[3]");
});
