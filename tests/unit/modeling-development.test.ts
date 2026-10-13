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
