import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parsePreparationConfig,
  prepareModeling,
} from "../../src/evaluation/benchmarks/modeling/prepare";
import { main, parseArguments } from "../../src/evaluation/cli";

const temporary = await mkdtemp(resolve(tmpdir(), "statigent-prepare-cli-"));
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});
test("prepare has explicit options and does not accept paid model configuration", async () => {
  await expect(
    main(["prepare", "--models", "configs/models.json"]),
  ).rejects.toThrow("evaluate prepare");
  expect(() =>
    parseArguments(["plan", "--config", "x", "--out", "prepared"]),
  ).toThrow();
  const config: unknown = await Bun.file(
    "configs/evaluations/dsbench-modeling-prepare.json",
  ).json();
  expect(parsePreparationConfig(config).benchmark).toBe("dsbench-modeling");
  await expect(
    prepareModeling([
      "--config",
      "configs/evaluations/dsbench-modeling-prepare.json",
      "--reuse",
      temporary,
    ]),
  ).rejects.toThrow("--receipt");
});
test("preparation command failure persists one bounded diagnostic without model secrets", async () => {
  const directory = resolve(temporary, "prepared"),
    receipt = resolve(temporary, "receipt.json");
  let calls = 0;
  await expect(
    prepareModeling(
      [
        "--config",
        "configs/evaluations/dsbench-modeling-prepare.json",
        "--out",
        directory,
        "--receipt",
        receipt,
      ],
      {
        execute: async (args, options) => {
          calls++;
          expect(args).toContain("statigent_benchmarks.prepare");
          expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
          expect(options?.timeout_ms).toBe(120000);
          throw new Error("controlled timeout");
        },
      },
    ),
  ).rejects.toThrow("controlled timeout");
  const report = await Bun.file(receipt).json();
  expect(report.status).toBe("failed");
  expect(report.error).toContain("controlled timeout");
  expect(report.llm_calls).toBe(0);
  expect(calls).toBe(1);
  const original = await Bun.file(receipt).text();
  await expect(
    prepareModeling([
      "--config",
      "configs/evaluations/dsbench-modeling-prepare.json",
      "--out",
      directory,
      "--receipt",
      receipt,
    ]),
  ).rejects.toThrow();
  expect(await Bun.file(receipt).text()).toBe(original);
});
