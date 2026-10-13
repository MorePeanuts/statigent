import type { Experiment } from "./experiments";
import { type Protocol, validateScore } from "./protocol";
import { assertEvaluation, type ValidationPlan } from "./validation";
export interface ConfirmationResult {
  mode: ValidationPlan["mode"];
  status: "disabled" | "pending" | "complete" | "incomplete";
  shortlist: { experiment_id: string; code_sha256: string }[];
  comparison: "single_pipeline" | "two_pipelines";
  trial_ids: string[];
  ranking: {
    experiment_id: string;
    scores: number[];
    mean: number;
    range: number;
  }[];
  selected_experiment_id: string | null;
  reason: string;
}
export function shortlist(
  experiments: readonly Experiment[],
  protocol: Protocol,
  plan: ValidationPlan,
) {
  const successful = experiments.filter(
    (e) => e.status === "completed" && !e.final && e.phase === "search",
  );
  for (const e of successful) {
    if (!e.evaluation) throw new Error("Missing search evaluation");
    assertEvaluation(e.evaluation, plan.search);
    validateScore(e.score, protocol, plan.search.evaluation_id);
  }
  const sorted = [...successful].sort((a, b) => {
    const difference = (a.score?.value ?? 0) - (b.score?.value ?? 0);
    return protocol.direction === "minimize" ? difference : -difference;
  });
  const hashes = new Set<string>();
  return sorted
    .filter((e) => {
      if (hashes.has(e.code_sha256)) return false;
      hashes.add(e.code_sha256);
      return true;
    })
    .slice(0, 2);
}
export function confirmationResult(
  candidates: readonly Experiment[],
  trials: readonly Experiment[],
  protocol: Protocol,
  plan: ValidationPlan,
): ConfirmationResult {
  if (!candidates.length) throw new Error("No successful search pipeline");
  const result: ConfirmationResult = {
    mode: plan.mode,
    status: plan.mode === "none" ? "disabled" : "pending",
    shortlist: candidates.map((e) => ({
      experiment_id: e.id,
      code_sha256: e.code_sha256,
    })),
    comparison: candidates.length === 1 ? "single_pipeline" : "two_pipelines",
    trial_ids: trials.map((e) => e.id),
    ranking: [],
    selected_experiment_id:
      plan.mode === "none" ? (candidates[0]?.id ?? null) : null,
    reason:
      plan.mode === "none" ? "confirmation_disabled" : "awaiting_confirmation",
  };
  if (plan.mode === "none") {
    if (trials.length) throw new Error("Disabled confirmation has trials");
    return result;
  }
  const ids = new Set<string>(),
    pairs = new Set<string>();
  let failed = false;
  for (const trial of trials) {
    const candidate = candidates.find(
      (c) => c.id === trial.source_search_experiment_id,
    );
    const evaluation = plan.confirmation.find(
      (e) => e.evaluation_id === trial.evaluation?.evaluation_id,
    );
    const pair = `${trial.source_search_experiment_id}:${trial.evaluation?.evaluation_id}`;
    if (
      !candidate ||
      !evaluation ||
      !trial.evaluation ||
      trial.phase !== "confirmation" ||
      trial.final ||
      trial.code_sha256 !== candidate.code_sha256 ||
      trial.code !== candidate.code ||
      ids.has(trial.id) ||
      pairs.has(pair)
    )
      throw new Error("Invalid confirmation trial identity");
    ids.add(trial.id);
    pairs.add(pair);
    assertEvaluation(trial.evaluation, evaluation);
    if (trial.status !== "completed") failed = true;
    else validateScore(trial.score, protocol, evaluation.evaluation_id);
  }
  if (failed)
    return {
      ...result,
      status: "incomplete",
      reason: "required_confirmation_failed",
    };
  if (trials.length !== candidates.length * 2) return result;
  result.ranking = candidates
    .map((candidate) => {
      const scores = plan.confirmation.map((e) => {
        const trial = trials.find(
          (t) =>
            t.source_search_experiment_id === candidate.id &&
            t.evaluation?.evaluation_id === e.evaluation_id,
        );
        if (!trial?.score) throw new Error("Missing confirmation score");
        return trial.score.value;
      });
      // Averaging divided terms avoids overflow of the sum for very large RMSE.
      const mean = scores.reduce((sum, n) => sum + n / 2, 0),
        range = Math.max(...scores) - Math.min(...scores);
      if (!Number.isFinite(mean) || !Number.isFinite(range))
        throw new Error("Confirmation summary overflow");
      return { experiment_id: candidate.id, scores, mean, range };
    })
    .sort((a, b) =>
      protocol.direction === "minimize" ? a.mean - b.mean : b.mean - a.mean,
    );
  return {
    ...result,
    status: "complete",
    selected_experiment_id: result.ranking[0]?.experiment_id ?? null,
    reason: "all_confirmation_trials_succeeded",
  };
}
