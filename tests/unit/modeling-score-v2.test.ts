import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationResult, shortlist } from "../../src/modeling/confirmation";
import { csv } from "../../src/modeling/data";
import type { Experiment } from "../../src/modeling/experiments";
import { validatePredictionFilesV2 } from "../../src/modeling/predictions-v2";
import {
  predictionColumnsV2,
  validateProtocolV2,
} from "../../src/modeling/protocol-v2";
import type { ScoreV2 } from "../../src/modeling/score-v2";
import { betterV2, validateScoreV2 } from "../../src/modeling/score-v2";
import {
  DEFAULT_DATA_LIMITS,
  scoreFilesV2,
} from "../../src/modeling/scoring-v2";
import type { Evaluation, ValidationPlan } from "../../src/modeling/validation";
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
for (const metric of ["mae-v1", "r2-sklearn-v1"] as const) {
  test(`${metric} uses the same frozen definition for stable search and confirmation rankings`, () => {
    const p = protocol(metric),
      minimize = p.metric.direction === "minimize";
    const makeEvaluation = (
      phase: Evaluation["phase"],
      seed: number,
    ): Evaluation => ({
      evaluation_id: sha256(Buffer.from(`${phase}:${seed}`)),
      phase,
      model_seed: seed,
      split_seed: seed,
      split_method: "hash-v1",
      split: {
        train: ["a", "b"],
        validation: ["c", "d"],
        sha256: "a".repeat(64),
      },
      protocol_sha256: p.protocol_sha256,
      train_sha256: "b".repeat(64),
    });
    const plan: ValidationPlan = {
      version: 1,
      algorithm: "terminal-holdout-v1",
      mode: "terminal_repeated_holdout",
      search: makeEvaluation("search", 1),
      confirmation: [
        makeEvaluation("confirmation", 2),
        makeEvaluation("confirmation", 3),
      ],
      final: makeEvaluation("final", 1),
    };
    const experiment = (id: string, value: number): Experiment<ScoreV2> => ({
      id,
      candidate_id: id,
      code: id,
      code_sha256: sha256(Buffer.from(id)),
      status: "completed",
      reason: "ok",
      score: {
        ...score(metric, value),
        evaluation_id: plan.search.evaluation_id,
      },
      fit: null,
      predict: null,
      final: false,
      phase: "search",
      evaluation: plan.search,
    });
    const candidates = shortlist(
      [
        experiment("worse", minimize ? 2 : -2),
        experiment("first", minimize ? 1 : -1),
        experiment("tie", minimize ? 1 : -1),
      ],
      p,
      plan,
    );
    expect(candidates.map((e) => e.id)).toEqual(["first", "tie"]);
    const trials = candidates.flatMap((c) =>
      plan.confirmation.map(
        (e, i): Experiment<ScoreV2> => ({
          ...c,
          id: `${c.id}-${i}`,
          phase: "confirmation",
          evaluation: e,
          source_search_experiment_id: c.id,
          score: {
            ...score(
              metric,
              c.id === "tie" ? (minimize ? 0.5 : -0.5) : minimize ? 1.5 : -1.5,
            ),
            evaluation_id: e.evaluation_id,
            partition: "confirmation-validation",
          },
        }),
      ),
    );
    expect(
      confirmationResult(candidates, trials, p, plan).selected_experiment_id,
    ).toBe("tie");
    for (const update of [
      { scoring_version: "tabular-metrics-v1" },
      { partition: "search-training" },
      { evaluation_id: "c".repeat(64) },
    ]) {
      const bad = candidates.map((e) => ({
        ...e,
        score: { ...e.score, ...update },
      }));
      // 外部记录在版本/分区校验前仍为 unknown，不能靠 TS 类型断言接受。
      expect(() =>
        validateScoreV2(bad[0]?.score, p, {
          evaluation_id: plan.search.evaluation_id,
          partition: "search-validation",
        }),
      ).toThrow();
    }
    expect(() =>
      confirmationResult(
        candidates,
        trials.map((e) => ({
          ...e,
          score: {
            ...score(metric, 0.5),
            evaluation_id: e.evaluation?.evaluation_id ?? "",
          },
        })),
        p,
        plan,
      ),
    ).toThrow("partition");
  });
}
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
test("multi-target scores reject reordered targets and incorrect aggregates", () => {
  const p = protocol("mean-target-auc-v1");
  const valid = {
    metric: p.metric.id,
    direction: p.metric.direction,
    value: 0.5,
    protocol_sha256: p.protocol_sha256,
    scoring_version: p.scoring_version,
    metric_definition_sha256: p.metric.definition_sha256,
    ...evaluation,
    components: p.targets.map((target) => ({
      target: target.name,
      metric: "roc-auc-v1",
      value: 0.5,
      error: null,
    })),
  };
  expect(validateScoreV2(valid, p, evaluation).value).toBe(0.5);
  expect(() =>
    validateScoreV2(
      { ...valid, components: [...valid.components].reverse() },
      p,
      evaluation,
    ),
  ).toThrow("per-target");
  expect(() =>
    validateScoreV2({ ...valid, value: 0.6 }, p, evaluation),
  ).toThrow("aggregate");
});
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
