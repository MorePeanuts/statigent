import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import source from "../../configs/modeling/synthetic-prepare.json";
import { confirmationResult, shortlist } from "../../src/modeling/confirmation";
import {
  datasetProtocol,
  loadDataset,
  prepareDataset,
} from "../../src/modeling/data";
import type { Experiment } from "../../src/modeling/experiments";
import { better, validateScore } from "../../src/modeling/protocol";
import { createValidationPlan } from "../../src/modeling/validation";
import { sha256 } from "../../src/records/store";

async function setup(classification = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "confirm-select-"));
  await prepareDataset(classification ? binary : source, join(root, "data"));
  const { dataset, train } = await loadDataset(join(root, "data")),
    protocol = datasetProtocol(dataset),
    plan = createValidationPlan(dataset, train, "terminal_repeated_holdout");
  const pipeline = (id: string, value: number, code = id): Experiment => ({
    id,
    candidate_id: "same_candidate",
    code,
    code_sha256: sha256(Buffer.from(code)),
    status: "completed",
    reason: "ok",
    score: {
      metric: protocol.metric,
      direction: protocol.direction,
      value,
      protocol_sha256: protocol.protocol_sha256,
      scoring_version: protocol.scoring_version,
      evaluation_id: plan.search.evaluation_id,
    },
    fit: null,
    predict: null,
    final: false,
    phase: "search",
    evaluation: plan.search,
    source_search_experiment_id: null,
  });
  return { protocol, plan, pipeline };
}
test("shortlist deduplicates code, preserves earlier ties and permits two implementations of one candidate", async () => {
  const { protocol, plan, pipeline } = await setup();
  const candidates = [
    pipeline("a", 2, "same"),
    pipeline("b", 1, "same"),
    pipeline("c", 1, "different"),
    pipeline("d", 1, "different"),
  ];
  expect(shortlist(candidates, protocol, plan).map((e) => e.id)).toEqual([
    "b",
    "c",
  ]);
  expect(shortlist([pipeline("single", 3)], protocol, plan)).toHaveLength(1);
});
for (const classification of [false, true])
  test(`confirmation can reverse search rank with metric direction (${classification})`, async () => {
    const { protocol, plan, pipeline } = await setup(classification),
      candidates = shortlist(
        [
          pipeline("a", classification ? 0.9 : 1),
          pipeline("b", classification ? 0.8 : 2),
        ],
        protocol,
        plan,
      );
    const trials = candidates.flatMap((c) =>
      plan.confirmation.map((evaluation, i) => ({
        ...c,
        id: `${c.id}-${i}`,
        phase: "confirmation" as const,
        evaluation,
        source_search_experiment_id: c.id,
        score: {
          ...validateScore(c.score, protocol),
          value:
            c.id === "b"
              ? classification
                ? 0.9
                : 1
              : classification
                ? 0.2
                : 3,
          evaluation_id: evaluation.evaluation_id,
        },
      })),
    );
    const result = confirmationResult(candidates, trials, protocol, plan);
    expect(result.status).toBe("complete");
    expect(result.selected_experiment_id).toBe("b");
    expect(result.ranking[0]?.scores).toHaveLength(2);
    const tied = trials.map((t) => ({
      ...t,
      score: { ...validateScore(t.score, protocol), value: 0.5 },
    }));
    expect(
      confirmationResult(candidates, tied, protocol, plan)
        .selected_experiment_id,
    ).toBe("a");
    const first = trials[0],
      candidate = candidates[0];
    if (!first || !candidate) throw new Error("Missing fixture trials");
    expect(() => better(first.score, candidate.score)).toThrow("Incomparable");
    const failure = trials.map((t, i) =>
      i === 1
        ? { ...t, status: "failed" as const, score: null, reason: "timeout" }
        : t,
    );
    expect(
      confirmationResult(candidates, failure, protocol, plan),
    ).toMatchObject({
      status: "incomplete",
      ranking: [],
      selected_experiment_id: null,
    });
    expect(
      confirmationResult(candidates, trials.slice(0, 1), protocol, plan)
        .selected_experiment_id,
    ).toBeNull();
    expect(() =>
      confirmationResult(candidates, [...trials, first], protocol, plan),
    ).toThrow();
  });
