import { expect, test } from "bun:test";
import {
  applyKnowledgeUpdates,
  type KnowledgeUpdate,
  parseKnowledgeUpdates,
  requireKnowledge,
} from "../../src/modeling/knowledge";

const scope = {
  run_id: "run",
  dataset_sha256: "a".repeat(64),
  protocol_sha256: "b".repeat(64),
};
const hypothesis: KnowledgeUpdate = {
  op: "create",
  id: "h",
  kind: "hypothesis",
  base_revision: null,
  statement: "A nonlinear model may help",
  status: "open",
  reason: "Test a modeling explanation",
  sources: [],
  candidate_ids: [],
};
const observation: KnowledgeUpdate = {
  ...hypothesis,
  id: "o",
  kind: "observation",
  status: "active",
  statement: "The numeric feature has missing values",
  sources: [
    {
      kind: "profile",
      profile_sha256: "c".repeat(64),
      path: "/columns/1/missing",
    },
  ],
};
test("revisions preserve the observation and every earlier hypothesis including withdrawal", () => {
  const initial = applyKnowledgeUpdates(
    [],
    [observation, hypothesis],
    scope,
    1,
  );
  const changed = applyKnowledgeUpdates(
    initial,
    [
      {
        ...hypothesis,
        op: "revise",
        base_revision: 1,
        status: "challenged",
        reason: "The experiment did not improve performance",
      },
    ],
    scope,
    3,
  );
  const withdrawn = applyKnowledgeUpdates(
    changed,
    [{ ...hypothesis, op: "revise", base_revision: 2, status: "withdrawn" }],
    scope,
    4,
  );
  expect(initial).toHaveLength(2);
  expect(withdrawn).toHaveLength(4);
  expect(requireKnowledge(withdrawn, { id: "o", revision: 1 })).toEqual(
    requireKnowledge(initial, { id: "o", revision: 1 }),
  );
  expect(requireKnowledge(withdrawn, { id: "h", revision: 1 }).status).toBe(
    "open",
  );
  expect(
    requireKnowledge(withdrawn, { id: "h", revision: 3 }).previous_revision,
  ).toBe(2);
  expect(applyKnowledgeUpdates(withdrawn, [], scope, 5)).toEqual(withdrawn);
});
test("stale, duplicate, incompatible and forged host fields reject the whole preview", () => {
  const history = applyKnowledgeUpdates([], [hypothesis], scope, 2);
  for (const changes of [
    [hypothesis],
    [hypothesis, hypothesis],
    [{ ...hypothesis, op: "revise", base_revision: 2 }],
    [
      {
        ...hypothesis,
        op: "revise",
        base_revision: 1,
        kind: "question",
        status: "resolved",
      },
    ],
    [{ ...observation, sources: [] }],
    [{ ...hypothesis, status: "active" }],
    [{ ...hypothesis, accepted_sequence: 2 }],
    [
      {
        ...hypothesis,
        status: "supported",
        sources: [
          { kind: "experiment", experiment_id: "failed", fact: "failure" },
        ],
      },
    ],
  ])
    expect(() => applyKnowledgeUpdates(history, changes, scope, 3)).toThrow();
  expect(history).toHaveLength(1);
  expect(() =>
    applyKnowledgeUpdates(
      history,
      [{ ...hypothesis, op: "revise", base_revision: 1 }],
      scope,
      2,
    ),
  ).toThrow();
  expect(() => requireKnowledge(history, { id: "h", revision: 2 })).toThrow();
  expect(parseKnowledgeUpdates([])).toEqual([]);
});
