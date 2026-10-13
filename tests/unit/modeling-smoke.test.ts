import { expect, test } from "bun:test";
import { auditCollaboration } from "../../src/modeling/smoke";

test("smoke rejects completed runs without the actual evidence-linked order", () => {
  const manifest = {
    status: "completed",
    experiments: [
      { id: "a", candidate_id: "base", final: false, status: "completed" },
      { id: "b", candidate_id: "next", final: false, status: "completed" },
      { id: "c", final: true, status: "completed" },
    ],
    analyses: [{ id: "eda", source_experiment: "a", status: "completed" }],
  };
  const events = [
    { type: "experiment_result", experiment_id: "a", status: "completed" },
    { type: "child_result", analysis_id: "eda", status: "completed" },
    { type: "experiment_intent", candidate_id: "next", final: false },
  ];
  const actions = [
    { kind: "train", candidate_id: "next", evidence: [{ analysis_id: "eda" }] },
  ];
  expect(auditCollaboration(manifest, events, actions).analysis_id).toBe("eda");
  expect(
    auditCollaboration(manifest, events, [
      {
        kind: "train",
        candidate_id: "failed_attempt",
        evidence: [{ analysis_id: "eda" }],
      },
      ...actions,
    ]).followup_candidate,
  ).toBe("next");
  expect(
    auditCollaboration(
      manifest,
      [
        { type: "experiment_intent", candidate_id: "next", final: false },
        ...events,
      ],
      actions,
    ).analysis_id,
  ).toBe("eda");
  expect(() =>
    auditCollaboration(manifest, [...events].reverse(), actions),
  ).toThrow("order");
  expect(() => auditCollaboration(manifest, events, [])).toThrow(
    "evidence-linked",
  );
  expect(() =>
    auditCollaboration({ ...manifest, analyses: [] }, events, actions),
  ).toThrow("EDA");
  expect(() =>
    auditCollaboration({ ...manifest, status: "failed" }, events, actions),
  ).toThrow("complete");
});
