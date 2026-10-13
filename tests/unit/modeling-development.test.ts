import { expect, test } from "bun:test";
import { developmentGoal } from "../../src/modeling/development";
import { workflowTrajectory } from "../../src/modeling/trajectory";

test("natural development has no prescribed analysis sequence and separates delivery from collaboration coverage", () => {
  expect(developmentGoal("Build a reliable predictor", "collaborative")).toBe(
    "Build a reliable predictor",
  );
  const manifest = {
    schema_version: 4,
    status: "completed",
    search_end: { kind: "agent_finished", reason: "done" },
    delivery: { status: "completed", artifact: {} },
    usage: { tokens: { status: "known" } },
    analyses: [],
    experiments: [],
  };
  expect(workflowTrajectory(manifest, [], [])).toMatchObject({
    completion: "autonomous",
    collaboration: "not_covered",
    core_rejections: [],
    attachment_warnings: [],
  });
  expect(
    workflowTrajectory({ ...manifest, schema_version: 5 }, [], []),
  ).toEqual(workflowTrajectory(manifest, [], []));
  expect(
    workflowTrajectory(
      {
        ...manifest,
        search_end: { kind: "protected", reason: "accounting_incomplete" },
        usage: { tokens: { status: "unknown" } },
      },
      [],
      [],
    ),
  ).toMatchObject({
    completion: "protected",
    accounting: "unknown",
    protection_reason: "accounting_incomplete",
  });
  expect(
    workflowTrajectory(
      {
        ...manifest,
        status: "failed",
        delivery: { status: "failed", artifact: null },
      },
      [],
      [],
    ),
  ).toMatchObject({ completion: "incomplete", delivery_status: "failed" });
});

test("natural collaboration coverage records observed order separately from optional declared sources", () => {
  const m = {
    schema_version: 4,
    status: "completed",
    search_end: { kind: "agent_finished", reason: "done" },
    delivery: { status: "completed", artifact: {} },
    usage: { tokens: { status: "known" } },
    analyses: [{ id: "a", status: "completed" }],
    experiments: [{ id: "e", phase: "search", status: "completed" }],
  };
  const view = workflowTrajectory(
    m,
    [
      { sequence: 1, type: "child_result", analysis_id: "a" },
      { sequence: 2, type: "action_accepted", intent: { experiment_id: "e" } },
    ],
    [{ accepted: { core: { kind: "train" }, sources: [], warnings: [] } }],
  );
  expect(view).toMatchObject({
    collaboration: "covered",
    analysis_calls: 1,
    analysis_followups: [{ analysis_id: "a", experiment_id: "e" }],
    analysis_experiment_links: [],
  });
});
