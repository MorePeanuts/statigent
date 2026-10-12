import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type Budget,
  emptyUsage,
  type Submission,
  validateScore,
  validateSubmission,
} from "./contracts";
import { publishInputs } from "./files";
import type { Plan, Registry } from "./plan";
import { EvaluationStore, inspect } from "./records";

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
export async function runEvaluation(
  plan: Plan,
  registry: Registry,
  root: string,
  options: { signal?: AbortSignal; environment?: Record<string, unknown> } = {},
) {
  const benchmark = registry.getBenchmark(plan.config.benchmark.adapter);
  const preflight: Record<string, Record<string, unknown>> = {};
  for (const config of plan.config.agents)
    preflight[config.id] = await registry
      .getAgent(config.adapter)
      .preflight(config);
  const store = await EvaluationStore.create(
    root,
    plan,
    preflight,
    options.environment,
  );
  const records = (await inspect(store.directory)).records;
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
      try {
        const inputRoot = join(store.directory, "units", unit.id, "input");
        await publishInputs(plan.source_root, task, inputRoot);
        unitSignal.throwIfAborted();
        const runRoot = join(store.directory, "native", unit.id);
        await mkdir(runRoot);
        const pinned = preflight[config.id]?.image_id;
        const invocationConfig =
          typeof pinned === "string"
            ? { ...config, options: { ...config.options, image: pinned } }
            : config;
        submission = validateSubmission(
          await adapter.run(
            {
              schema_version: 1,
              evaluation_id: store.manifest.evaluation_id,
              unit_id: unit.id,
              task,
              config: invocationConfig,
              budget,
              seed: unit.seed,
              input_root: inputRoot,
              run_root: runRoot,
            },
            unitSignal,
          ),
          unit.id,
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
          schema_version: 1,
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
          artifacts: [],
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
      record.submission_sha256 = await store.freeze(submission);
      await store.unit(record);
      await store.event("unit_finished", {
        unit_id: unit.id,
        status: submission.status,
        usage: submission.usage,
      });
      try {
        if (submission.cleanup_error)
          throw new Error("Scoring blocked by incomplete cleanup");
        record.score = validateScore(
          await benchmark.score(
            plan.config.benchmark.options,
            task,
            submission,
            signal,
          ),
          unit.id,
        );
      } catch (error) {
        record.score = {
          schema_version: 1,
          unit_id: unit.id,
          protocol: benchmark.protocol,
          status: "failed",
          metrics: [],
          details: {},
          error: error instanceof Error ? error.message : String(error),
        };
      }
      record.scoring_status = record.score.status;
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
