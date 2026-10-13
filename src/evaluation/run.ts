import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelClient } from "../models/client";
import type { ModelProfile } from "../models/config";
import {
  type BenchmarkAdapter,
  type Budget,
  emptyUsage,
  type PublicTask,
  type Score,
  type Submission,
  validateScore,
  validateSubmission,
} from "./contracts";
import {
  freezeDeliverables,
  quarantineDeliverables,
  validateReport,
} from "./deliverables";
import { publishTaskInputs } from "./files";
import { JudgeBudgetExhausted, JudgeSession } from "./judge";
import type { Plan, Registry } from "./plan";
import { EvaluationStore, inspect, type UnitRecord } from "./records";

export function effectiveBudget(
  task: Budget,
  batch: Budget,
  used: { attempts: number; tokens: number },
  remainingMs: number,
): Budget {
  const minimum = (a: number | null, b: number | null, spent: number) =>
    a === null
      ? b === null
        ? null
        : Math.max(0, b - spent)
      : b === null
        ? a
        : Math.max(0, Math.min(a, b - spent));
  return {
    timeout_ms: Math.max(0, Math.min(task.timeout_ms, remainingMs)),
    model_attempts: minimum(
      task.model_attempts,
      batch.model_attempts,
      used.attempts,
    ),
    total_tokens: minimum(task.total_tokens, batch.total_tokens, used.tokens),
  };
}
/**
 * Freezes whatever the adapter wrote. Invalid directories are quarantined so the unit is still scored
 * as a failed delivery instead of crashing the batch.
 */
async function finalizeDeliverables(
  submission: Submission,
  task: PublicTask,
  root: string,
): Promise<void> {
  try {
    if (submission.deliverables.length)
      throw new Error("Adapters must not list deliverables themselves");
    submission.deliverables = await freezeDeliverables(root, task.output);
    if (
      submission.trajectory !== null &&
      !submission.deliverables.some((d) => d.path === submission.trajectory)
    )
      throw new Error("Declared trajectory was not delivered");
  } catch (error) {
    await quarantineDeliverables(root);
    submission.deliverables = [];
    submission.trajectory = null;
    submission.status = "failed";
    submission.answer_text = "";
    submission.reason = `invalid_deliverables:${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (task.output.kind === "report" && submission.status === "completed")
    try {
      await validateReport(task.output, root, submission.deliverables);
    } catch (error) {
      submission.status = "failed";
      submission.reason = `invalid_report:${error instanceof Error ? error.message : String(error)}`;
    }
}
export function failedScore(
  unitId: string,
  benchmark: BenchmarkAdapter,
  error: unknown,
  judge: Score["judge"] = null,
): Score {
  return {
    schema_version: 2,
    unit_id: unitId,
    protocol: benchmark.protocol,
    status: "failed",
    metrics: [],
    details: {},
    error: error instanceof Error ? error.message : String(error),
    judge,
  };
}
/** Scores one frozen unit; judge failures become scoring errors, never wrong answers. */
export async function scoreUnit(
  plan: Plan,
  benchmark: BenchmarkAdapter,
  record: UnitRecord,
  submission: Submission,
  deliverablesRoot: string,
  session: JudgeSession | null,
  signal?: AbortSignal,
): Promise<void> {
  const task = plan.tasks.find((t) => t.id === record.unit.task_id);
  if (!task) throw new Error("Missing task");
  if (session?.exhausted) {
    record.score = null;
    record.scoring_status = "not_scored";
    record.scoring_reason = session.exhausted;
    return;
  }
  const judge = session?.forUnit(record.unit.id, signal) ?? null;
  const began = Date.now();
  try {
    if (submission.cleanup_error)
      throw new Error("Scoring blocked by incomplete cleanup");
    const score = validateScore(
      await benchmark.score(plan.config.benchmark.options, task, submission, {
        deliverables_root: deliverablesRoot,
        scoring: plan.config.scoring?.options ?? {},
        judge,
        signal,
      }),
      record.unit.id,
    );
    record.score = { ...score, judge: judge ? judge.summary() : null };
  } catch (error) {
    if (
      error instanceof JudgeBudgetExhausted &&
      judge &&
      judge.ledger.attempts === 0
    ) {
      // Nothing was sent for this unit: it was never judged rather than judged and failed.
      record.score = null;
      record.scoring_status = "not_scored";
      record.scoring_reason = error.message;
      record.scoring_elapsed_ms = Date.now() - began;
      return;
    }
    record.score = failedScore(
      record.unit.id,
      benchmark,
      error,
      judge ? judge.summary() : null,
    );
  }
  record.scoring_status = record.score.status;
  delete record.scoring_reason;
  record.scoring_elapsed_ms = Date.now() - began;
}
export function judgeSession(
  plan: Plan,
  benchmark: BenchmarkAdapter,
  directory: string,
  factory?: (profile: ModelProfile) => ModelClient,
): JudgeSession | null {
  const roles = benchmark.judgeRoles?.(plan.config.scoring?.options ?? {});
  if (!roles?.length || !plan.config.scoring) return null;
  return new JudgeSession(
    plan.config.scoring,
    directory,
    plan.config.agents.flatMap((a) => (a.model ? [a.model.model] : [])),
    factory,
  );
}
export async function runEvaluation(
  plan: Plan,
  registry: Registry,
  root: string,
  options: {
    signal?: AbortSignal;
    environment?: Record<string, unknown>;
    judgeFactory?: (profile: ModelProfile) => ModelClient;
  } = {},
) {
  const benchmark = registry.getBenchmark(plan.config.benchmark.adapter);
  const preflight: Record<string, Record<string, unknown>> = {};
  for (const config of plan.config.agents)
    preflight[config.id] = await registry
      .getAgent(config.adapter)
      .preflight(config);
  // Judge credentials are checked before any agent runs; the directory is fixed once the batch exists.
  judgeSession(plan, benchmark, "", options.judgeFactory)?.preflight();
  const store = await EvaluationStore.create(
    root,
    plan,
    preflight,
    options.environment,
  );
  const records = (await inspect(store.directory)).records;
  // The batch report later reuses this score id, so judge logs and report share one directory.
  const scoreId = randomUUID();
  const scoreDirectory = join(store.directory, "scores", scoreId, "judge");
  const session = judgeSession(
    plan,
    benchmark,
    scoreDirectory,
    options.judgeFactory,
  );
  const trajectory =
    benchmark.requiresTrajectory?.(plan.config.scoring?.options ?? {}) ?? false;
  const began = Date.now(),
    deadline = began + plan.config.batch_budget.timeout_ms;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(),
    plan.config.batch_budget.timeout_ms,
  );
  const used = { attempts: 0, tokens: 0 };
  let stop = "";
  try {
    for (const record of records) {
      const unit = record.unit,
        task = plan.tasks.find((t) => t.id === unit.task_id),
        config = plan.config.agents.find((a) => a.id === unit.agent_id);
      if (!task || !config) throw new Error("Invalid frozen plan identity");
      const adapter = registry.getAgent(config.adapter),
        cap = adapter.capabilities;
      const budget = effectiveBudget(
        plan.config.task_budget,
        plan.config.batch_budget,
        used,
        deadline - Date.now(),
      );
      if (signal.aborted)
        stop ||= options.signal?.aborted ? "cancelled" : "batch_timeout";
      if (
        budget.timeout_ms <= 0 ||
        budget.model_attempts === 0 ||
        budget.total_tokens === 0
      )
        stop ||= "batch_budget_exhausted";
      if (stop) {
        record.execution_status = "not_run";
        record.reason = stop;
        await store.unit(record);
        continue;
      }
      record.effective_budget = budget;
      record.budget_status =
        JSON.stringify(budget) === JSON.stringify(plan.config.task_budget)
          ? "within"
          : "reduced";
      record.started_at = new Date().toISOString();
      record.execution_status = "running";
      await store.unit(record);
      await store.event("unit_start", { unit, budget });
      const started = Date.now();
      const unitController = new AbortController();
      const unitSignal = AbortSignal.any([signal, unitController.signal]);
      const unitTimer = setTimeout(
        () => unitController.abort(),
        budget.timeout_ms,
      );
      let submission: Submission;
      const deliverablesRoot = join(
        store.directory,
        "units",
        unit.id,
        "deliverables",
      );
      await mkdir(deliverablesRoot, { mode: 0o700 });
      try {
        const inputRoot = join(store.directory, "units", unit.id, "input");
        const publication = await publishTaskInputs(
          plan.source_root,
          task,
          inputRoot,
        );
        const method = publication.method;
        await store.event("inputs_published", { unit_id: unit.id, method });
        unitSignal.throwIfAborted();
        const runRoot = join(store.directory, "native", unit.id);
        await mkdir(runRoot);
        const pinned = preflight[config.id]?.image_id;
        const invocationConfig =
          typeof pinned === "string"
            ? { ...config, options: { ...config.options, image: pinned } }
            : config;
        if (task.output.kind === "predictions") {
          budget.timeout_ms = Math.max(
            0,
            budget.timeout_ms - (Date.now() - started),
          );
          record.effective_budget = { ...budget };
          record.budget_status = "reduced";
          await store.unit(record);
          await store.event("effective_parent_budget", {
            unit_id: unit.id,
            budget,
          });
        }
        submission = validateSubmission(
          await adapter.run(
            {
              schema_version: task.output.kind === "predictions" ? 3 : 2,
              evaluation_id: store.manifest.evaluation_id,
              unit_id: unit.id,
              task,
              config: invocationConfig,
              budget,
              seed: unit.seed,
              input_root: inputRoot,
              ...(publication.phase_roots
                ? { phase_roots: publication.phase_roots }
                : {}),
              run_root: runRoot,
              deliverables_root: deliverablesRoot,
              trajectory,
            },
            unitSignal,
          ),
          unit.id,
          { frozen: false, output: task.output },
        );
        if (
          cap.model === "none"
            ? submission.usage.source !== "not_applicable"
            : submission.usage.source === "not_applicable"
        )
          throw new Error("Usage violates declared model capability");
        if (
          cap.usage === "self_reported" &&
          submission.usage.source === "measured"
        )
          throw new Error("Unverified measurement provenance");
      } catch (error) {
        submission = {
          schema_version: task.output.kind === "predictions" ? 3 : 2,
          unit_id: unit.id,
          status: signal.aborted
            ? options.signal?.aborted
              ? "cancelled"
              : "timed_out"
            : unitController.signal.aborted
              ? "timed_out"
              : "failed",
          answer_text: "",
          reason: error instanceof Error ? error.message : String(error),
          deliverables: [],
          trajectory: null,
          native_run: null,
          usage: emptyUsage(
            cap.model === "none" ? "not_applicable" : "unknown",
          ),
          record_error: false,
          cleanup_error: null,
        };
      } finally {
        clearTimeout(unitTimer);
      }
      // Cancellation cannot be turned into success by a late adapter response.
      if (signal.aborted || unitController.signal.aborted) {
        submission.status = options.signal?.aborted ? "cancelled" : "timed_out";
        submission.answer_text = "";
      }
      await finalizeDeliverables(submission, task, deliverablesRoot);
      record.elapsed_ms = Date.now() - started;
      record.ended_at = new Date().toISOString();
      record.execution_status = submission.status;
      record.reason = submission.reason;
      used.attempts += submission.usage.attempts;
      used.tokens += submission.usage.total_tokens;
      if (submission.usage.unknown_attempts) {
        record.budget_status = "unknown";
        if (
          plan.config.batch_budget.model_attempts !== null ||
          plan.config.batch_budget.total_tokens !== null
        )
          stop = "unknown_model_usage";
      } else if (
        (budget.model_attempts !== null &&
          submission.usage.attempts > budget.model_attempts) ||
        (budget.total_tokens !== null &&
          submission.usage.total_tokens > budget.total_tokens)
      )
        record.budget_status = "exceeded";
      if (submission.record_error || submission.cleanup_error)
        stop = submission.cleanup_error
          ? "cleanup_failed"
          : "agent_record_failed";
      record.submission_sha256 = await store.freeze(submission, task.output);
      await store.unit(record);
      await store.event("unit_finished", {
        unit_id: unit.id,
        status: submission.status,
        usage: submission.usage,
      });
      await scoreUnit(
        plan,
        benchmark,
        record,
        submission,
        deliverablesRoot,
        session,
        signal,
      );
      await store.unit(record);
    }
    const complete = records.every(
      (r) =>
        r.scoring_status === "scored" &&
        !["not_run", "pending", "running", "unconfirmed"].includes(
          r.execution_status,
        ),
    );
    await store.finish(complete && !stop ? "completed" : "incomplete", stop);
    return {
      evaluation_id: store.manifest.evaluation_id,
      directory: store.directory,
      status: store.manifest.status,
      score_id: scoreId,
    };
  } catch (error) {
    const reason = `record_or_runner_failure:${error instanceof Error ? error.message : String(error)}`;
    try {
      await store.finish("incomplete", reason);
    } catch (recordError) {
      throw new Error(
        `${reason}; cannot finalize ${store.directory}: ${String(recordError)}`,
      );
    }
    throw new Error(`${reason}; evaluation=${store.manifest.evaluation_id}`);
  } finally {
    clearTimeout(timer);
  }
}
