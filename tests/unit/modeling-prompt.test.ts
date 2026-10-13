import { expect, test } from "bun:test";
import {
  applyKnowledgeUpdates,
  type KnowledgeRevision,
} from "../../src/modeling/knowledge";
import {
  analysisContext,
  boundedState,
  knowledgeView,
} from "../../src/modeling/prompt";

const scope = {
  run_id: "r",
  dataset_sha256: "a".repeat(64),
  protocol_sha256: "b".repeat(64),
};
function history(count: number, statement = "Investigate this pattern") {
  let result: KnowledgeRevision[] = [];
  for (let i = 0; i < count; i++)
    result = applyKnowledgeUpdates(
      result,
      [
        {
          op: "create",
          id: `q${i}`,
          kind: "question",
          base_revision: null,
          statement,
          status: "open",
          reason: "Need evidence",
          sources: [],
          candidate_ids: [],
        },
      ],
      scope,
      i + 1,
    );
  return result;
}
test("bounded knowledge keeps exact explicit revisions and lists omitted identities", () => {
  const h = history(30),
    refs = [{ id: "q29", revision: 1 }],
    view = knowledgeView(h, refs);
  expect(view.entries[0]?.id).toBe("q29");
  expect(view.entries).toHaveLength(24);
  expect(view.omitted).toHaveLength(6);
  expect(
    analysisContext({ question: "Follow up", candidates: [], history: h, refs })
      .knowledge,
  ).toEqual(view);
  expect(() => knowledgeView(h, [{ id: "q29", revision: 2 }])).toThrow();
});
test("oversized required references are rejected rather than silently omitted", () => {
  const h = history(10, "x".repeat(8192));
  expect(() =>
    knowledgeView(
      h,
      h.map(({ id, revision }) => ({ id, revision })),
    ),
  ).toThrow("context limit");
  expect(knowledgeView(h).omitted.length).toBeGreaterThan(0);
});

test("oversized common modeling state stops instead of silently truncating facts", () => {
  expect(() =>
    boundedState({ candidates: [{ reason: "x".repeat(262144) }] }),
  ).toThrow("state context limit");
  expect(boundedState({ candidates: [] })).toEqual({ candidates: [] });
});
