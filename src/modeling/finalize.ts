import { randomUUID } from "node:crypto";
import { Stop } from "../agent/stop";
import type { Budget } from "./budget";
import type { ModelingTask } from "./config";
import { type ConfirmationResult, confirmationResult } from "./confirmation";
import { type Dataset, datasetProtocol, type Table } from "./data";
import { type Experiment, runExperiment } from "./experiments";
import type { Score } from "./protocol";
import {
  assertEvaluation,
  type Evaluation,
  type ValidationPlan,
} from "./validation";
import {
  type ModelingProtocol,
  type ModelingScore,
  validateEvaluationScore,
} from "./versioned-score";
export interface FinalizationOptions<S extends ModelingScore> {
  task: ModelingTask;
  protocol: ModelingProtocol;
  root: string;
  signal: AbortSignal;
  remaining: () => number;
  check: () => void;
  budget: Budget;
  plan: ValidationPlan;
  candidates: Experiment<S>[];
  finalId: string;
  executeExperiment: (
    candidate: Experiment<S>,
    evaluation: Evaluation,
    id: string,
    remaining: () => number,
  ) => Promise<Experiment<S>>;
  onConfirmation: (result: ConfirmationResult) => Promise<void>;
  onIntent: (
    id: string,
    candidate: Experiment<S>,
    evaluation: Evaluation,
    retry: boolean,
  ) => Promise<void>;
  onStage: (id: string, experiment: string) => Promise<void>;
  onResult: (experiment: Experiment<S>) => Promise<void>;
}
export async function finalizeExperiments<S extends ModelingScore>(
  o: FinalizationOptions<S>,
) {
  const protocol = o.protocol,
    trials: Experiment<S>[] = [];
  let confirmation = confirmationResult(o.candidates, trials, protocol, o.plan);
  await o.onConfirmation(confirmation);
  const execute = async (
    candidate: Experiment<S>,
    evaluation: Evaluation,
    id: string,
    retry = false,
  ) => {
    o.check();
    await o.onIntent(id, candidate, evaluation, retry);
    if (evaluation.phase === "confirmation") o.budget.confirm(id);
    else o.budget.train(true);
    const result = await o.executeExperiment(
      candidate,
      evaluation,
      id,
      evaluation.phase === "confirmation"
        ? () => Math.min(o.remaining(), o.budget.confirmationMs())
        : o.remaining,
    );
    if (
      result.id !== id ||
      result.candidate_id !== candidate.candidate_id ||
      !result.evaluation ||
      result.phase !== evaluation.phase ||
      result.final !== (evaluation.phase === "final") ||
      result.source_search_experiment_id !== candidate.id ||
      result.code !== candidate.code ||
      result.code_sha256 !== candidate.code_sha256
    )
      throw new Error("Unconfirmed finalization experiment identity");
    assertEvaluation(result.evaluation, evaluation);
    if (result.status === "completed" && evaluation.phase !== "final")
      validateEvaluationScore(result.score, protocol, evaluation);
    else if (result.score !== null)
      throw new Error("Unexpected finalization score");
    await o.onResult(result);
    if (result.execution_confirmed === false)
      throw new Stop("failed", `unconfirmed_finalization:${result.reason}`);
    return result;
  };
  if (o.plan.mode !== "none") {
    try {
      for (const candidate of o.candidates)
        for (const evaluation of o.plan.confirmation) {
          const trial = await execute(candidate, evaluation, randomUUID());
          trials.push(trial);
          confirmation = confirmationResult(
            o.candidates,
            trials,
            protocol,
            o.plan,
          );
          await o.onConfirmation(confirmation);
          if (trial.status !== "completed")
            throw new Stop("failed", `confirmation_incomplete:${trial.reason}`);
        }
    } catch (error) {
      if (confirmation.status !== "incomplete") {
        confirmation = {
          ...confirmation,
          status: "incomplete",
          selected_experiment_id: null,
          ranking: [],
          reason: String(error),
        };
        await o.onConfirmation(confirmation);
      }
      throw error;
    }
  }
  const selected = o.candidates.find(
    (c) => c.id === confirmation.selected_experiment_id,
  );
  if (!selected) throw new Stop("failed", "confirmation_incomplete");
  let id = o.finalId,
    retry = false;
  while (true) {
    const final = await execute(selected, o.plan.final, id, retry);
    o.check();
    if (final.status === "completed") return { selected, final, confirmation };
    if (
      !final.reason.startsWith("error:") ||
      o.budget.finalTraining >= o.task.budget.final_training_attempts
    )
      throw new Stop("failed", `finalization_failed:${final.reason}`);
    retry = true;
    id = randomUUID();
  }
}

export async function finalizeModeling(
  o: Omit<FinalizationOptions<Score>, "protocol" | "executeExperiment"> & {
    dataset: Dataset;
    train: Table;
    test: Table;
    execute?: typeof runExperiment;
  },
) {
  return finalizeExperiments({
    ...o,
    protocol: datasetProtocol(o.dataset),
    executeExperiment: (candidate, evaluation, id, remaining) =>
      (o.execute ?? runExperiment)({
        task: o.task,
        dataset: o.dataset,
        train: o.train,
        test: o.test,
        root: o.root,
        code: candidate.code,
        candidateId: candidate.candidate_id,
        signal: o.signal,
        remaining,
        final: evaluation.phase === "final",
        evaluation,
        sourceSearchExperimentId: candidate.id,
        id,
        onStage: (child) => o.onStage(child, id),
      }),
  });
}
