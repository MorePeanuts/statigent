import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csv } from "../../src/modeling/data";
import { validatePredictionFilesV2 } from "../../src/modeling/predictions-v2";
import {
  predictionColumnsV2,
  validateProtocolV2,
} from "../../src/modeling/protocol-v2";
import { betterV2, validateScoreV2 } from "../../src/modeling/score-v2";
import {
  DEFAULT_DATA_LIMITS,
  scoreFilesV2,
} from "../../src/modeling/scoring-v2";
import { sha256 } from "../../src/records/store";
import fixtures from "../fixtures/modeling-protocol-v2.json";

const protocol = (id: string) =>
  validateProtocolV2(
    fixtures.valid.find((x) => x.input.metric_id === id)?.protocol,
  );
const evaluation = {
  evaluation_id: "a".repeat(64),
  partition: "search-validation" as const,
};
function score(id: string, value: number) {
  const p = protocol(id);
  return validateScoreV2(
    {
      metric: p.metric.id,
      direction: p.metric.direction,
      value,
      protocol_sha256: p.protocol_sha256,
      scoring_version: p.scoring_version,
      metric_definition_sha256: p.metric.definition_sha256,
      ...evaluation,
      components: [],
    },
    p,
    evaluation,
  );
}
test("V2 ranking keeps directions, ties and evaluation partitions distinct", () => {
  expect(betterV2(score("mae-v1", 1), score("mae-v1", 2))).toBe(true);
  expect(betterV2(score("r2-sklearn-v1", -1), score("r2-sklearn-v1", -2))).toBe(
    true,
  );
  expect(betterV2(score("mae-v1", 1), score("mae-v1", 1))).toBe(false);
  const s = score("mae-v1", 1);
  for (const update of [
    { evaluation_id: "b".repeat(64) },
    { partition: "test" as const },
    { metric_definition_sha256: "b".repeat(64) },
  ])
    expect(() => betterV2({ ...s, ...update }, s)).toThrow("Incomparable");
  expect(() => score("mae-v1", Infinity)).toThrow();
  expect(() => score("mae-v1", -1)).toThrow();
  expect(() =>
    validateScoreV2(
      { ...s, partition: "test" },
      protocol("mae-v1"),
      evaluation,
    ),
  ).toThrow();
});
test("external ranked files validate with public IDs and no model artifacts", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "external-ranked-")),
  );
  try {
    const p = protocol("top3-hit-ds-v1");
    const ref = async (name: string, text: string) => {
      const path = join(root, name);
      await writeFile(path, text);
      return {
        path,
        bytes: Buffer.byteLength(text),
        sha256: sha256(Buffer.from(text)),
      };
    };
    const expected = await ref("ids.csv", "id\na\nb\n");
    const classes = p.targets[0]?.classes;
    if (!classes) throw new Error("Missing fixture classes");
    const predictions = await ref(
      "ranked.csv",
      csv({
        columns: predictionColumnsV2(p, false),
        rows: [
          ["b", JSON.stringify(classes.slice(0, 2))],
          ["a", JSON.stringify(classes.slice(0, 3))],
        ],
      }),
    );
    const result = await validatePredictionFilesV2({
      root,
      protocol: p,
      expected,
      predictions,
      limits: DEFAULT_DATA_LIMITS,
    });
    expect(result.rows).toBe(2);
    expect(result.predictions_sha256).toBe(predictions.sha256);
    const bad = await ref(
      "bad.csv",
      csv({
        columns: predictionColumnsV2(p, false),
        rows: [
          ["a", JSON.stringify([classes[0], classes[0]])],
          ["b", JSON.stringify(classes.slice(0, 2))],
        ],
      }),
    );
    await expect(
      validatePredictionFilesV2({
        root,
        protocol: p,
        expected,
        predictions: bad,
        limits: DEFAULT_DATA_LIMITS,
      }),
    ).rejects.toThrow("duplicate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("trusted V2 bridge reads file references and returns the frozen metric", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "modeling-score-v2-")),
  );
  try {
    const ref = async (name: string, text: string) => {
      const path = join(root, name);
      await writeFile(path, text);
      return {
        path,
        bytes: Buffer.byteLength(text),
        sha256: sha256(Buffer.from(text)),
      };
    };
    const p = protocol("mae-v1");
    const labels = await ref("labels.csv", "id,target_0\na,10\nb,20\n");
    const predictions = await ref(
      "predictions.csv",
      `id,${p.prediction.targets[0]?.value_column}\nb,17\na,11\n`,
    );
    const result = await scoreFilesV2({
      root,
      protocol: p,
      labels,
      predictions,
      limits: DEFAULT_DATA_LIMITS,
      ...evaluation,
    });
    expect(result.error).toBeNull();
    expect(result.score?.value).toBe(2);
    expect(result.score?.partition).toBe("search-validation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
