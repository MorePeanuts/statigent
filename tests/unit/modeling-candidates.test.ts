import { describe, expect, test } from "bun:test";
import { action } from "../../src/modeling/legacy-actions";
import {
  applyCandidateUpdates,
  attachExperiment,
  type CandidateExperiment,
  type CandidateUpdate,
  candidateSummary,
  parseCandidateUpdates,
  requireCandidate,
  validateCandidateState,
  validateRepair,
} from "../../src/modeling/candidates";

function create(id: string, priority = 1): CandidateUpdate {
  return {
    op: "create",
    id,
    hypothesis: `Hypothesis ${id}`,
    change: "Fit a linear model",
    priority,
    reason: "Direct baseline",
    evidence: [],
  };
}
function update(
  id: string,
  disposition: "keep" | "defer" | "resume",
  priority: number | null = null,
): CandidateUpdate {
  return {
    op: "update",
    id,
    priority,
    disposition,
    reason: "New decision",
    evidence: [],
  };
}
function train() {
  return {
    candidate_updates: [create("base")],
    candidate_id: "base",
    change: "Baseline",
    reason: "Direct baseline",
    source_experiment: null,
    repair_of_experiment: null,
    evidence: [],
    code: "def build_pipeline(seed): pass",
  };
}
function analysis() {
  return {
    candidate_updates: [],
    candidates: ["base"],
    question: "Does linearity hold?",
    expected_evidence: "Residual correlation",
    decision_rules: "Try nonlinear model if residuals correlate",
    source_experiment: "exp1",
    requested_budget: {
      task_timeout_ms: 1000,
      total_tokens: 2000,
      executions: 2,
    },
    budget_reason: "One focused diagnostic",
  };
}
const experiment: CandidateExperiment = {
  id: "exp1",
  candidate_id: "base",
  status: "failed",
  reason: "NameError: feature",
  rmse: null,
  final: false,
};

describe("candidate state", () => {
  test("stable priority order, host-derived attempts, defer and resume", () => {
    const initial = applyCandidateUpdates(
      [],
      [create("base", 2), create("other", 2), create("first", 1)],
      3,
    );
    expect(candidateSummary(initial, []).map((c) => c.id)).toEqual([
      "first",
      "base",
      "other",
    ]);
    const deferred = applyCandidateUpdates(
      initial,
      [update("base", "defer")],
      3,
    );
    expect(requireCandidate(deferred, "base").status).toBe("deferred");
    expect(() => requireCandidate(deferred, "base", { active: true })).toThrow(
      "resume",
    );
    const resumed = applyCandidateUpdates(
      deferred,
      [update("base", "resume", 1)],
      3,
    );
    expect(requireCandidate(resumed, "base").status).toBe("pending");
    expect(candidateSummary(resumed, []).map((c) => c.id)).toEqual([
      "base",
      "first",
      "other",
    ]);
    const tried = attachExperiment(resumed, "base", "exp1");
    const deferredTried = applyCandidateUpdates(
      tried,
      [update("base", "defer")],
      3,
    );
    const kept = applyCandidateUpdates(
      deferredTried,
      [update("base", "keep", 2)],
      3,
    );
    expect(requireCandidate(kept, "base").status).toBe("deferred");
    const retried = applyCandidateUpdates(kept, [update("base", "resume")], 3);
    expect(requireCandidate(retried, "base").status).toBe("tried");
    expect(requireCandidate(retried, "base").experiment_ids).toEqual(["exp1"]);
    expect(requireCandidate(retried, "base").revision).toBe(7);
    expect(initial[0]?.status).toBe("pending");
    expect(initial[0]?.revision).toBe(1);
  });

  test("batch preflight never partly mutates state and deferred IDs still consume capacity", () => {
    const initial = applyCandidateUpdates([], [create("base")], 2);
    const original = structuredClone(initial);
    expect(() =>
      applyCandidateUpdates(
        initial,
        [update("base", "defer"), update("missing", "resume")],
        2,
      ),
    ).toThrow("Unknown");
    expect(initial).toEqual(original);
    expect(() => applyCandidateUpdates(initial, [create("base")], 2)).toThrow(
      "exists",
    );
    expect(() =>
      applyCandidateUpdates(
        initial,
        [update("base", "defer"), update("base", "resume")],
        2,
      ),
    ).toThrow("Duplicate");
    const full = applyCandidateUpdates(
      initial,
      [create("other"), update("base", "defer")],
      2,
    );
    expect(() => applyCandidateUpdates(full, [create("third")], 2)).toThrow(
      "limit",
    );
    expect(() =>
      attachExperiment(
        attachExperiment(initial, "base", "exp1"),
        "base",
        "exp1",
      ),
    ).toThrow("already");
  });

  test("fixed definitions and execution facts cannot be provided by model updates", () => {
    for (const extras of [
      { hypothesis: "Replace idea" },
      { change: "Replace direction" },
      { status: "tried" },
      { revision: 99 },
      { experiment_ids: ["exp1"] },
      { rmse: 0 },
    ]) {
      expect(() =>
        parseCandidateUpdates([{ ...update("base", "keep"), ...extras }], 2),
      ).toThrow("Unsupported");
    }
    expect(() =>
      parseCandidateUpdates([{ ...create("base"), priority: 0 }], 2),
    ).toThrow("priority");
    expect(() =>
      parseCandidateUpdates([{ ...create("base"), reason: " " }], 2),
    ).toThrow("reason");
    expect(() =>
      parseCandidateUpdates(
        [{ ...create("base"), hypothesis: "x".repeat(8193) }],
        2,
      ),
    ).toThrow("too long");
    const initial = applyCandidateUpdates([], [create("base")], 2);
    expect(() =>
      validateCandidateState([{ ...initial[0], status: "tried" }], 2),
    ).toThrow("contradicts");
  });

  test("summary distinguishes failed and unconfirmed attempts and bounds history", () => {
    const initial = applyCandidateUpdates([], [create("base")], 2);
    const first = attachExperiment(initial, "base", "exp1");
    expect(candidateSummary(first, [experiment])[0]).toMatchObject({
      status: "tried",
      attempts: 1,
      latest_experiment: { id: "exp1", status: "failed", rmse: null },
    });
    const second = attachExperiment(first, "base", "exp2");
    const summary = candidateSummary(second, [experiment])[0];
    expect(summary).toMatchObject({
      status: "tried",
      attempts: 2,
      latest_experiment: {
        id: "exp2",
        status: "unconfirmed",
        rmse: null,
        final: null,
      },
    });
    expect(summary).not.toHaveProperty("experiment_ids");
    expect(requireCandidate(second, "base").hypothesis).toBe("Hypothesis base");
    const longDiagnostic = candidateSummary(first, [
      { ...experiment, reason: "x".repeat(20_000) },
    ])[0];
    expect(longDiagnostic?.latest_experiment?.reason.length).toBeLessThan(1100);
    expect(longDiagnostic?.latest_experiment?.reason).toContain("truncated");
  });

  test("repair only targets a confirmed failed search experiment of this candidate", () => {
    expect(() => validateRepair([experiment], "base", "exp1")).not.toThrow();
    expect(() => validateRepair([], "base", null)).not.toThrow();
    expect(() => validateRepair([], "base", "exp1")).toThrow("confirmed");
    for (const invalid of [
      { ...experiment, candidate_id: "other" },
      { ...experiment, status: "completed", rmse: 1 },
      { ...experiment, status: "unconfirmed" },
      { ...experiment, final: true },
    ]) {
      expect(() => validateRepair([invalid], "base", "exp1")).toThrow(
        "confirmed",
      );
    }
  });
});

describe("modeling v2 action protocol", () => {
  test("first training creates candidate, analyze uses IDs and finish accepts empty updates", () => {
    const first = action("run_experiment", JSON.stringify(train()), 1000, 3);
    expect(first).toMatchObject({
      kind: "train",
      repair_of_experiment: null,
      candidate_updates: [{ op: "create", id: "base" }],
    });
    const planned = action("analyze", JSON.stringify(analysis()), 1000, 3);
    expect(planned).toMatchObject({
      candidates: ["base"],
      requested_budget: {
        task_timeout_ms: 1000,
        total_tokens: 2000,
        executions: 2,
      },
    });
    expect(
      action(
        "finish_modeling",
        JSON.stringify({
          candidate_updates: [],
          experiment_id: "exp1",
          reason: "Best trusted result",
        }),
        1000,
        3,
      ),
    ).toMatchObject({ kind: "finish", candidate_updates: [] });
    expect(() =>
      action(
        "run_experiment",
        JSON.stringify({ ...train(), hypothesis: "Old field" }),
        1000,
        3,
      ),
    ).toThrow("Unsupported");
    const { candidate_updates: _updates, ...old } = train();
    expect(() =>
      action("run_experiment", JSON.stringify(old), 1000, 3),
    ).toThrow("update count");
  });

  test("rejects unknown fields, malformed candidates, duplicate updates and invalid budgets", () => {
    expect(() =>
      action(
        "analyze",
        JSON.stringify({
          ...analysis(),
          candidates: [{ id: "base", change: "Old protocol", priority: 1 }],
        }),
        1000,
        3,
      ),
    ).toThrow();
    expect(() =>
      action(
        "analyze",
        JSON.stringify({ ...analysis(), candidates: ["base", "base"] }),
        1000,
        3,
      ),
    ).toThrow("Duplicate");
    expect(() =>
      action(
        "run_experiment",
        JSON.stringify({
          ...train(),
          candidate_updates: [create("base"), update("base", "keep")],
        }),
        1000,
        3,
      ),
    ).toThrow("Duplicate");
    expect(() =>
      action(
        "analyze",
        JSON.stringify({ ...analysis(), budget_reason: "" }),
        1000,
        3,
      ),
    ).toThrow("budget reason");
    for (const field of ["task_timeout_ms", "total_tokens", "executions"]) {
      for (const value of [
        0,
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        null,
        "100",
      ])
        expect(() =>
          action(
            "analyze",
            JSON.stringify({
              ...analysis(),
              requested_budget: {
                ...analysis().requested_budget,
                [field]: value,
              },
            }),
            1000,
            3,
          ),
        ).toThrow();
    }
    expect(() =>
      action(
        "analyze",
        JSON.stringify({
          ...analysis(),
          requested_budget: { ...analysis().requested_budget, unknown: 1 },
        }),
        1000,
        3,
      ),
    ).toThrow("Unsupported");
    const { requested_budget: _budget, ...missing } = analysis();
    expect(() => action("analyze", JSON.stringify(missing), 1000, 3)).toThrow();
  });
});
