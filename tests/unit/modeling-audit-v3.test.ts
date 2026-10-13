import { expect, test } from "bun:test";
import { auditCollaborationV3 } from "../../src/modeling/audit-v3";
import incomplete from "../fixtures/modeling-collaboration/incomplete.json";
import success from "../fixtures/modeling-collaboration/success.json";

const audit = (f: typeof success) =>
  auditCollaborationV3(f.manifest, f.events, f.actions);
test("saved v3 trajectory accepts completed collaboration after an early failure without demanding score improvement", () => {
  expect(audit(success)).toMatchObject({
    mode: "full_collaboration",
    performance_gain: "not_asserted",
  });
  const worse = structuredClone(success);
  const search = worse.manifest.experiments.filter((e) => e.phase === "search");
  for (const e of search) if (e.score) e.score.value = 999;
  expect(audit(worse).followup_experiment).toBeString();
  expect(() => audit(incomplete)).toThrow();
});
test("v3 acceptance rejects missing exploration, revision, context, follow-up or confirmation", () => {
  for (const missing of [
    "exploration",
    "revision",
    "context",
    "followup",
    "confirmation",
    "exploration_receipt",
  ]) {
    const f = structuredClone(success);
    if (missing === "exploration")
      f.manifest.analyses = f.manifest.analyses.filter(
        (a) => a.request.purpose !== "explore",
      );
    if (missing === "revision") f.manifest.knowledge_control.history = [];
    if (missing === "context")
      for (const a of f.manifest.analyses) a.request.knowledge_refs = [];
    if (missing === "followup")
      f.manifest.experiments = f.manifest.experiments.filter(
        (e) => e.phase !== "search",
      );
    if (missing === "confirmation")
      f.manifest.confirmation.status = "incomplete";
    if (missing === "exploration_receipt") {
      const exploration = f.manifest.analyses.find(
        (a) => a.status === "completed" && a.request.purpose === "explore",
      );
      f.events = f.events.filter(
        (e) => e.analysis_id !== exploration?.id || e.type !== "child_result",
      );
    }
    expect(() => audit(f)).toThrow();
  }
});
