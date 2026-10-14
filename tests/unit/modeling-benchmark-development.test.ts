import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelingOptions } from "../../src/evaluation/agents/modeling";
import {
  auditPreparations,
  preparationAuditConfig,
} from "../../src/evaluation/benchmarks/modeling/preparation-audit";
import { MODELING_DEVELOPMENT } from "../../src/evaluation/modeling-development";
import { MODELING_METHODS } from "../../src/modeling/config";
import { sha256 } from "../../src/records/store";

test("fixed development covers all special outputs with identical four-method resources and exposed provenance", async () => {
  const manifest = await Bun.file(
    "benchmarks/metadata/modeling-development.json",
  ).json();
  expect(manifest.selected.map((t: { task_id: string }) => t.task_id)).toEqual(
    MODELING_DEVELOPMENT.map((t) => t.task_id),
  );
  expect(manifest.catalog_sha256).toBe(
    sha256(
      Buffer.from(
        await Bun.file(
          "benchmarks/metadata/modeling-task-catalog.json",
        ).bytes(),
      ),
    ),
  );
  expect(new Set(MODELING_DEVELOPMENT.map((t) => t.coverage)).size).toBe(7);
  for (const benchmark of ["dsbench-modeling", "tabarena-lite"]) {
    const normalized = [];
    for (const method of MODELING_METHODS) {
      const config = await Bun.file(
        `configs/evaluations/modeling-development/${benchmark}-${method}.json`,
      ).json();
      expect(config.agents[0].options.method).toBe(method);
      expect(config.agents[0].model_profile).toBe("deepseek-flash");
      expect(modelingOptions(config.agents[0].options).confirmation.mode).toBe(
        "terminal_repeated_holdout",
      );
      expect(config.purpose).toBe("development");
      expect(config.cache_policy).toBe("disabled");
      expect(config.development_overlap).toContain("s3e9");
      const { method: _method, ...options } = config.agents[0].options;
      normalized.push({
        ...config,
        agents: [{ ...config.agents[0], id: "method", options }],
      });
    }
    for (const config of normalized) expect(config).toEqual(normalized[0]);
  }
});

test("bounded audit retains failures, oversized candidates and undispatched tasks without model calls", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "preparation-audit-")),
  );
  try {
    const catalog = await Bun.file(
      "benchmarks/metadata/modeling-task-catalog.json",
    ).json();
    await writeFile(
      join(root, "catalog.json"),
      JSON.stringify({ ...catalog, tasks: catalog.tasks.slice(0, 3) }),
    );
    const config = {
      ...(await Bun.file(
        "configs/evaluations/modeling-preparation-audit.json",
      ).json()),
      catalog: join(root, "catalog.json"),
      minimum_free_bytes: 1,
    };
    expect(preparationAuditConfig(config).seed).toBe(17);
    expect(() =>
      preparationAuditConfig({ ...config, unknown: true }),
    ).toThrow();
    await writeFile(join(root, "config.json"), JSON.stringify(config));
    let attempts = 0;
    const options = {
      sourceAudit: async () => ({}),
      prepare: async () => {
        attempts++;
        throw new Error("invalid training classes");
      },
    };
    const result = await auditPreparations(
      ["--config", join(root, "config.json"), "--out", join(root, "audit")],
      options,
    );
    expect(attempts).toBe(1);
    expect(result.report.tasks.map((t) => t.status)).toEqual([
      "failed",
      "blocked",
      "blocked",
    ]);
    expect(result.report.fits).toBe(0);
    expect(result.report.llm_calls).toBe(0);
    const cancelled = new AbortController();
    cancelled.abort();
    const skipped = await auditPreparations(
      ["--config", join(root, "config.json"), "--out", join(root, "cancelled")],
      { ...options, signal: cancelled.signal },
    );
    expect(attempts).toBe(1);
    expect(skipped.report.tasks.map((t) => t.status)).toEqual([
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(skipped.report.tasks.every((t) => t.reason === "cancelled")).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
