import { expect, test } from "bun:test";
import {
  applyCandidateUpdates,
  requireCandidate,
} from "../../src/modeling/candidates";
import {
  applyKnowledgeUpdates,
  type KnowledgeUpdate,
} from "../../src/modeling/knowledge";
import {
  analysisSourceHints,
  type KnowledgeFacts,
  validateKnowledgeLinks,
  validateKnowledgeSources,
} from "../../src/modeling/knowledge-sources";
import { createProtocol } from "../../src/modeling/protocol";
import { sha256 } from "../../src/records/store";
import { createCandidate } from "../helpers/modeling";

function fixture() {
  const protocol = createProtocol("regression", "rmse", [], null, "id");
  const scope = {
    run_id: "run",
    dataset_sha256: "a".repeat(64),
    protocol_sha256: protocol.protocol_sha256,
  };
  const profile = {
    generator: "basic-profile-v1",
    identity: {
      train_sha256: scope.dataset_sha256,
      members_sha256: "b".repeat(64),
      split_sha256: "c".repeat(64),
      protocol_sha256: scope.protocol_sha256,
    },
    rows: 10,
    column_count: 0,
    missing_policy: "empty-string-only",
    limits: { columns: 128, category_values: 10, text_characters: 128 },
    columns: [],
  };
  const facts: KnowledgeFacts = {
    scope,
    profile,
    profile_sha256: sha256(Buffer.from(JSON.stringify(profile))),
    protocol,
    experiments: [
      {
        id: "e",
        scope,
        phase: "search",
        status: "completed",
        reason: "ok",
        prediction_sha256: "d".repeat(64),
        score: {
          metric: "rmse",
          direction: "minimize",
          value: 2,
          protocol_sha256: scope.protocol_sha256,
          scoring_version: protocol.scoring_version,
        },
      },
      {
        id: "failed",
        scope,
        phase: "search",
        status: "failed",
        reason: "SyntaxError",
        prediction_sha256: null,
        score: null,
      },
    ],
    analyses: [
      {
        id: "a",
        scope,
        status: "completed",
        source_sha256: "e".repeat(64),
        sources: [{ experiment_id: "e", prediction_sha256: "d".repeat(64) }],
        analysis: {
          summary: "finding",
          findings: [
            { statement: "Residual pattern", evidence_refs: ["cell1"] },
          ],
          methods: [],
          limitations: [],
        },
      },
    ],
  };
  const update: KnowledgeUpdate = {
    op: "create",
    id: "k",
    kind: "observation",
    base_revision: null,
    statement: "An observed fact",
    status: "active",
    reason: "Investigate",
    candidate_ids: [],
    sources: [],
  };
  return { facts, update };
}

test("source hints bind exact accepted findings and never expose failed analyses as evidence", () => {
  const { facts, update } = fixture();
  const a = facts.analyses[0];
  if (!a?.analysis) throw Error("Missing analysis");
  a.analysis.findings.push({
    statement: "Other finding",
    evidence_refs: ["cell2"],
  });
  const hints = analysisSourceHints(a);
  expect(hints).toHaveLength(2);
  for (const hint of hints)
    expect(() =>
      validateKnowledgeSources([{ ...update, sources: [hint] }], facts),
    ).not.toThrow();
  expect(analysisSourceHints({ ...a, status: "failed" })).toEqual([]);
  const first = hints[0];
  if (!first) throw Error("Missing source hint");
  expect(() =>
    validateKnowledgeSources(
      [{ ...update, sources: [{ ...first, evidence_refs: ["cell2"] }] }],
      facts,
    ),
  ).toThrow('valid refs for this finding: ["cell1"]');
});
test("profile, finding and experiment facts resolve only against accepted host identities", () => {
  const { facts, update } = fixture();
  for (const source of [
    {
      kind: "profile" as const,
      profile_sha256: facts.profile_sha256,
      path: "/rows",
    },
    {
      kind: "analysis" as const,
      analysis_id: "a",
      finding: 0,
      evidence_refs: ["cell1"],
      source_sha256: "e".repeat(64),
      applicability: "Original experiment e",
    },
    { kind: "experiment" as const, experiment_id: "e", fact: "score" as const },
    {
      kind: "experiment" as const,
      experiment_id: "failed",
      fact: "failure" as const,
    },
  ])
    expect(() =>
      validateKnowledgeSources([{ ...update, sources: [source] }], facts),
    ).not.toThrow();
  expect(() =>
    validateKnowledgeSources(
      [
        {
          ...update,
          sources: [
            { kind: "experiment", experiment_id: "failed", fact: "score" },
          ],
        },
      ],
      facts,
    ),
  ).toThrow();
  const forged = {
    ...update,
    sources: [
      { kind: "experiment", experiment_id: "e", fact: "score", value: 0 },
    ],
  };
  expect(() =>
    validateKnowledgeSources([forged as KnowledgeUpdate], facts),
  ).toThrow("Unsupported field");
});
test("cross-task, failed EDA, wrong finding and changed prediction are not evidence", () => {
  const { facts, update } = fixture();
  const source = {
    kind: "analysis" as const,
    analysis_id: "a",
    finding: 0,
    evidence_refs: ["cell1"],
    source_sha256: "e".repeat(64),
    applicability: "e",
  };
  for (const patch of [
    { finding: 2 },
    { evidence_refs: ["other"] },
    { source_sha256: "f".repeat(64) },
  ])
    expect(() =>
      validateKnowledgeSources(
        [{ ...update, sources: [{ ...source, ...patch }] }],
        facts,
      ),
    ).toThrow();
  for (const mutation of [
    (f: KnowledgeFacts) => {
      const a = f.analyses[0];
      if (a) a.scope = { ...a.scope, run_id: "other" };
    },
    (f: KnowledgeFacts) => {
      const a = f.analyses[0];
      if (a) a.status = "failed";
    },
    (f: KnowledgeFacts) => {
      const e = f.experiments[0];
      if (e) e.prediction_sha256 = "f".repeat(64);
    },
  ]) {
    const changed = structuredClone(facts);
    mutation(changed);
    expect(() =>
      validateKnowledgeSources([{ ...update, sources: [source] }], changed),
    ).toThrow();
  }
});
test("candidate links target exact revisions, and failed code does not mutate hypotheses", () => {
  const { facts, update } = fixture();
  const history = applyKnowledgeUpdates(
    [],
    [{ ...update, kind: "hypothesis", status: "open", sources: [] }],
    facts.scope,
    1,
  );
  const candidates = applyCandidateUpdates(
    [],
    [
      {
        ...createCandidate("c"),
        op: "create",
        evidence: [],
        knowledge_refs: [{ id: "k", revision: 1 }],
      },
    ],
    16,
    true,
  );
  expect(() => validateKnowledgeLinks(history, candidates)).not.toThrow();
  expect(() =>
    validateKnowledgeLinks(history, [
      {
        ...requireCandidate(candidates, "c"),
        knowledge_refs: [{ id: "k", revision: 2 }],
      },
    ]),
  ).toThrow();
  validateKnowledgeSources(
    [
      {
        ...update,
        sources: [
          { kind: "experiment", experiment_id: "failed", fact: "failure" },
        ],
      },
    ],
    facts,
  );
  expect(history[0]?.status).toBe("open");
  expect(() =>
    applyCandidateUpdates(
      [],
      [
        {
          ...createCandidate("c"),
          op: "create",
          evidence: [],
          knowledge_refs: [],
        },
      ],
      16,
    ),
  ).toThrow();
});
