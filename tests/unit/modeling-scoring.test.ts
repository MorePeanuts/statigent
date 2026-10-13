import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  better,
  createProtocol,
  validateScore,
} from "../../src/modeling/protocol";
import { ScoringFailure, scoreTables } from "../../src/modeling/scoring";
import { obj } from "../../src/models/validation";

async function options() {
  return {
    root: await mkdtemp(join(await realpath(tmpdir()), "score-")),
    protocol: createProtocol("binary", "accuracy", ["01", "1"], "01", "id"),
    id: "id",
    target: "y",
    labels: {
      columns: ["id", "y"],
      rows: [
        ["a", "01"],
        ["b", "1"],
      ],
    },
    predictions: {
      columns: ["id", "prediction"],
      rows: [
        ["b", "1"],
        ["a", "01"],
      ],
    },
  };
}
test("trusted uv scorer runs data-only, preserves literal labels, bounds time and excludes credentials", async () => {
  const o = await options();
  expect((await scoreTables(o)).score?.value).toBe(1);
  process.env.STATIGENT_TEST_SECRET = "never-forward";
  try {
    await scoreTables({
      ...o,
      timeout_ms: 123,
      execute: async (args, opts) => {
        expect(args).toEqual([
          "uv",
          "run",
          "--offline",
          "--frozen",
          "python",
          "-m",
          "statigent_modeling.scoring",
        ]);
        expect(opts?.env?.STATIGENT_TEST_SECRET).toBeUndefined();
        expect(opts?.timeout_ms).toBeLessThanOrEqual(123);
        expect(opts?.timeout_ms).toBeGreaterThan(0);
        expect(opts?.stdout_limit).toBe(1024 ** 2);
        expect(opts?.input).not.toContain("candidate.py");
        const r = obj(JSON.parse(opts?.input ?? "{}"));
        return {
          stderr: "",
          stdout: JSON.stringify({
            version: 1,
            request_id: r.request_id,
            protocol_sha256: o.protocol.protocol_sha256,
            ok: true,
            score: {
              metric: "accuracy",
              direction: "maximize",
              value: 1,
              protocol_sha256: o.protocol.protocol_sha256,
              scoring_version: o.protocol.scoring_version,
            },
          }),
        };
      },
    });
  } finally {
    delete process.env.STATIGENT_TEST_SECRET;
  }
});
test("scorer identity, protocol failure, timeout and cancellation are fatal and retained", async () => {
  const o = await options();
  for (const stdout of [
    "bad-json",
    JSON.stringify({ version: 1, request_id: "wrong", ok: true }),
  ])
    await expect(
      scoreTables({ ...o, execute: async () => ({ stdout, stderr: "" }) }),
    ).rejects.toBeInstanceOf(ScoringFailure);
  await expect(scoreTables({ ...o, timeout_ms: 0 })).rejects.toThrow(
    "deadline",
  );
  await expect(
    scoreTables({ ...o, signal: AbortSignal.abort() }),
  ).rejects.toBeInstanceOf(ScoringFailure);
  await expect(scoreTables({ ...o, timeout_ms: 1 })).rejects.toThrow(
    /timed out|deadline/,
  );
  expect(
    (await readdir(join(o.root, "scoring"), { recursive: true })).filter((f) =>
      f.endsWith("failure.json"),
    ),
  ).toHaveLength(5);
  expect(
    await scoreTables({
      ...o,
      labels: {
        columns: ["id", "y"],
        rows: [
          ["a", "unknown"],
          ["b", "1"],
        ],
      },
    }),
  ).toMatchObject({ score: null });
});
test("score comparison freezes direction and identity; ties preserve first", () => {
  for (const metric of ["accuracy", "log_loss"] as const) {
    const p = createProtocol("binary", metric, ["01", "1"], "01", "id");
    const a = {
      metric,
      direction: p.direction,
      value: 0.5,
      protocol_sha256: p.protocol_sha256,
      scoring_version: p.scoring_version,
    };
    expect(better(a, a)).toBe(false);
    expect(better({ ...a, value: 0.6 }, a)).toBe(metric === "accuracy");
    expect(() =>
      validateScore(
        { ...a, direction: metric === "accuracy" ? "minimize" : "maximize" },
        p,
      ),
    ).toThrow();
    expect(() => better({ ...a, protocol_sha256: "wrong" }, a)).toThrow();
  }
});
