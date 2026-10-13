import { expect, test } from "bun:test";
import { action } from "../../src/modeling/actions";
import {
  compileDecision,
  type DecisionContext,
  decisionTools,
  findingSources,
} from "../../src/modeling/decision";
import { applyKnowledgeUpdates } from "../../src/modeling/knowledge";
import { createProtocol } from "../../src/modeling/protocol";
import { obj } from "../../src/models/validation";

const context: DecisionContext = {
  profile_sha256: "a".repeat(64),
  knowledge: [],
  analyses: [
    {
      id: "eda",
      status: "completed",
      source_sha256: "b".repeat(64),
      analysis: {
        summary: "patterns",
        methods: [],
        limitations: [],
        findings: [
          { statement: "Missingness", evidence_refs: ["cell1"] },
          { statement: "Residual trend", evidence_refs: ["cell2"] },
        ],
      },
    },
  ],
};
const scope = {
  run_id: "r",
  dataset_sha256: "c".repeat(64),
  protocol_sha256: "d".repeat(64),
};
const question = {
  id: "q",
  kind: "question",
  statement: "Does this pattern warrant a feature?",
  reason: "Test the observed pattern",
};
function parse(updates: unknown[], ctx = context, refs: unknown[] = ["q"]) {
  return action(
    "analyze",
    compileDecision(
      JSON.stringify({
        candidate_updates: [],
        knowledge_updates: updates,
        knowledge_refs: refs,
        purpose: "explore",
        candidates: [],
        source_experiments: [],
        question: "Inspect missingness",
        expected_evidence: "Counts",
      }),
      ctx,
    ),
    10000,
    16,
    "collaborative",
  );
}
test("semantic decisions bind revisions and exact finding provenance without model-authored bookkeeping", () => {
  const first = parse([question]);
  expect(first.knowledge_updates?.[0]).toMatchObject({
    op: "create",
    base_revision: null,
    status: "open",
    sources: [],
  });
  const knowledge = applyKnowledgeUpdates(
    [],
    first.knowledge_updates,
    scope,
    1,
  );
  const next = parse(
    [
      {
        ...question,
        sources: [
          {
            source_id: "analysis:eda:1",
            applicability: "Diagnose this candidate",
          },
        ],
      },
    ],
    { ...context, knowledge },
  );
  expect(next.knowledge_updates?.[0]).toMatchObject({
    op: "revise",
    base_revision: 1,
    status: "open",
    sources: [
      {
        kind: "analysis",
        analysis_id: "eda",
        finding: 1,
        evidence_refs: ["cell2"],
        source_sha256: "b".repeat(64),
        applicability: "Diagnose this candidate",
      },
    ],
  });
  expect(next.knowledge_refs).toEqual([{ id: "q", revision: 2 }]);
  const history = applyKnowledgeUpdates(
    knowledge,
    next.knowledge_updates,
    scope,
    2,
  );
  expect(history).toHaveLength(2);
  expect(
    parse([], { ...context, knowledge: history }, [{ id: "q", revision: 1 }])
      .knowledge_refs,
  ).toEqual([{ id: "q", revision: 1 }]);
});
test("profile handles preserve exact identity and observations still require evidence", () => {
  const observed = {
    ...question,
    kind: "observation",
    sources: [{ source_id: "profile:/rows" }],
  };
  expect(parse([observed]).knowledge_updates?.[0]).toMatchObject({
    status: "active",
    sources: [
      {
        kind: "profile",
        path: "/rows",
        profile_sha256: context.profile_sha256,
      },
    ],
  });
  expect(() => parse([{ ...observed, sources: [] }])).toThrow(
    "requires a source",
  );
  expect(() => parse([{ ...question, status: "active" }])).toThrow(
    "Invalid knowledge status",
  );
  expect(() => parse([{ ...question, status: null }])).toThrow(
    "Invalid knowledge status",
  );
  expect(() => parse([{ ...question, sources: null }])).toThrow(
    "Invalid knowledge sources",
  );
});
test("source expansion rejects invented/failed findings, extra evidence and missing applicability", () => {
  for (const source of [
    { source_id: "analysis:other:0", applicability: "x" },
    { source_id: "analysis:eda:2", applicability: "x" },
    { source_id: "analysis:eda:0" },
    {
      source_id: "analysis:eda:0",
      applicability: "x",
      evidence_refs: ["cell2"],
    },
    { source_id: "basic_profile" },
  ])
    expect(() => parse([{ ...question, sources: [source] }])).toThrow();
  const failed = {
    ...context.analyses[0],
    id: "failed",
    status: "failed",
    analysis: null,
  };
  expect(findingSources(failed)).toEqual([]);
  expect(() =>
    parse(
      [
        {
          ...question,
          sources: [{ source_id: "analysis:failed:0", applicability: "x" }],
        },
      ],
      { ...context, analyses: [failed] },
    ),
  ).toThrow("unavailable");
  const first = context.analyses[0];
  if (!first) throw new Error("Missing analysis fixture");
  expect(findingSources(first)[1]?.source_id).toBe("analysis:eda:1");
});
test("explicit stale revisions and fabricated status support are not silently repaired", () => {
  const knowledge = applyKnowledgeUpdates(
    [],
    parse([question]).knowledge_updates,
    scope,
    1,
  );
  const stale = parse([{ ...question, op: "revise", base_revision: 9 }], {
    ...context,
    knowledge,
  });
  expect(() =>
    applyKnowledgeUpdates(knowledge, stale.knowledge_updates, scope, 2),
  ).toThrow("stale");
  expect(() =>
    parse([{ ...question, kind: "hypothesis", status: "supported" }]),
  ).toThrow("successful experiment");
  expect(() => parse([], context, ["unknown"])).toThrow("Unknown knowledge ID");
});
test("model-facing tools hide storage fields and keep knowledge optional and method-scoped", () => {
  const protocol = createProtocol("regression", "rmse", [], null, "id");
  for (const tool of decisionTools(protocol, "collaborative")) {
    const p = tool.function.parameters;
    expect(p.required).not.toContain("knowledge_updates");
    const item = obj(obj(p.properties.knowledge_updates).items);
    expect(obj(item.properties).op).toBeUndefined();
    expect(obj(item.properties).base_revision).toBeUndefined();
    expect(JSON.stringify(obj(item.properties).sources)).not.toContain(
      "sha256",
    );
  }
  for (const method of ["no_eda", "initial_eda", "adaptive_eda"] as const)
    for (const tool of decisionTools(protocol, method))
      expect(
        tool.function.parameters.properties.knowledge_updates,
      ).toBeUndefined();
});
