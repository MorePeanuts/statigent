import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelCaller } from "../agent/model-call";
import { Stop } from "../agent/stop";
import { ChatClient, type Message, type ModelClient } from "../models/client";
import {
  type ModelProfile,
  profileSnapshot,
  validateProfile,
} from "../models/config";
import { obj } from "../models/validation";
import type { ModelMetadata } from "../records/agent-metadata";
import { sha256 } from "../records/store";
import { modelingTools } from "./actions";
import { Budget } from "./budget";
import type { ModelingTask } from "./config";
import { type ConfirmationResult, shortlist } from "./confirmation";
import { findingSources } from "./decision";
import type { AnalysisOptions, AnalysisRecord } from "./eda";
import type { Experiment, runExperiment } from "./experiments";
import { finalizeExperiments } from "./finalize";
import type { BasicProfile } from "./profile";
import type { BasicProfileV2 } from "./profile-v2";
import { boundedState, contextIdentity } from "./prompt";
import { ModelingRecord } from "./records";
import type { Evaluation, ValidationPlan } from "./validation";
import { assertEvaluation } from "./validation";
import {
  type ModelingProtocol,
  type ModelingScore,
  validateEvaluationScore,
} from "./versioned-score";
import {
  acceptAttachments,
  CORRECTION_POLICY,
  type CoreAction,
  DECISION_INTERFACE,
  type Notes,
  parseCore,
  type SearchEnd,
  validateCore,
} from "./workflow";

export interface ModelingRuntime<S extends ModelingScore> {
  completion?: "model_frozen" | "completed";
  preparation?: unknown;
  dataset: unknown;
  protocol: ModelingProtocol;
  validationPlan: ValidationPlan;
  promptVersion: string;
  prompt: string;
  promptProtocol: unknown;
  initialQuestion: string;
  prepareProfile: (options: {
    root: string;
    timeout_ms: number;
    signal: AbortSignal;
  }) => Promise<{
    profile: BasicProfile | BasicProfileV2;
    artifact: { path: string; bytes: number; sha256: string };
    elapsed_ms: number;
  }>;
  execute: (
    options: Omit<
      Parameters<typeof runExperiment>[0],
      "dataset" | "train" | "test"
    > & { evaluation: Evaluation },
  ) => Promise<Experiment<S>>;
  analyze: (
    options: Omit<AnalysisOptions, "experiment" | "experiments"> & {
      experiment: Experiment<S> | null;
      experiments: Experiment<S>[];
    },
  ) => Promise<AnalysisRecord>;
  better: (score: S, best: S | null) => boolean;
  deliver: (options: {
    root: string;
    task: ModelingTask;
    selected: Experiment<S>;
    final: Experiment<S>;
    selection: {
      searchBest: Experiment<S>;
      confirmation: ConfirmationResult;
      plan: ValidationPlan;
    };
    signal: AbortSignal;
    remaining: () => number;
    onFrozen: (value: unknown) => Promise<void>;
    onPredictionStage: (id: string) => Promise<void>;
    onPredictionResult: (value: unknown) => Promise<void>;
  }) => Promise<unknown>;
}
export interface SessionOptions {
  task: ModelingTask;
  start: number;
  profile: ModelProfile;
  edaProfile: ModelProfile;
  runRoot: string;
  signal?: AbortSignal;
  client?: ModelClient;
  edaClient?: ModelClient;
  createRecord?: typeof ModelingRecord.create;
}
const protectedReasons = new Set([
  "accounting_incomplete",
  "model_attempts",
  "token_threshold",
  "token_preflight",
  "response_length",
  "request_size_limit",
  "action_corrections",
  "exploration_reserve",
]);
export async function runModelingSession<S extends ModelingScore>(
  o: SessionOptions,
  runtime: ModelingRuntime<S>,
) {
  const start = o.start,
    task = o.task,
    profile = validateProfile(o.profile),
    edaProfile = validateProfile(o.edaProfile);
  if (profile.id !== task.model_profile || edaProfile.id !== task.eda_profile)
    throw new Error("Profile/task mismatch");
  const protocol = runtime.protocol,
    validationPlan = runtime.validationPlan,
    prompt = runtime.prompt;
  const remaining = () =>
    Math.max(
      0,
      Math.floor(task.budget.task_timeout_ms - (performance.now() - start)),
    );
  const controller = new AbortController(),
    signal = o.signal
      ? AbortSignal.any([o.signal, controller.signal])
      : controller.signal;
  const timer = setTimeout(() => controller.abort(), remaining());
  const client = o.client ?? new ChatClient(profile);
  if (
    JSON.stringify(profileSnapshot(client.profile)) !==
    JSON.stringify(profileSnapshot(profile))
  ) {
    clearTimeout(timer);
    throw new Error("Client profile mismatch");
  }
  const budget = new Budget(
    task.budget,
    remaining,
    task.confirmation.mode === "none" ? 0 : 4,
  );
  const model: ModelMetadata = {
    profile: profileSnapshot(profile),
    returned_models: [],
    response_ids: [],
    fingerprints: [],
  };
  let record: ModelingRecord;
  try {
    record = await (o.createRecord ?? ModelingRecord.create)(
      o.runRoot,
      {
        task,
        dataset: runtime.dataset,
        ...(runtime.preparation === undefined
          ? {}
          : { preparation: runtime.preparation }),
        protocol,
        validation_plan: validationPlan,
        validation_plan_sha256: contextIdentity(validationPlan).sha256,
        model: profileSnapshot(profile),
        eda_model: profileSnapshot(edaProfile),
        tools: modelingTools(protocol, task.method).map((t) => t.function.name),
        prompt: {
          decision_interface: DECISION_INTERFACE,
          correction_policy: CORRECTION_POLICY,
          version: runtime.promptVersion,
          sha256: sha256(Buffer.from(prompt)),
        },
      },
      task.budget.max_trace_bytes,
    );
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  const experiments: Experiment<S>[] = [],
    analyses: AnalysisRecord[] = [],
    notesHistory: Notes[] = [];
  let best: Experiment<S> | undefined,
    selectedExperiment: Experiment<S> | undefined;
  let confirmation: ConfirmationResult | null = null,
    searchEnd: SearchEnd | null = null;
  let status = "running",
    reason = "",
    recordError = false,
    corrections = 0,
    executionConfirmed = true;
  let deliveryStatus:
    | "not_started"
    | "running"
    | "pending_prediction"
    | "completed"
    | "failed"
    | "cancelled" = "not_started";
  let artifact: unknown = null;
  let basicProfile: Awaited<
      ReturnType<ModelingRuntime<S>["prepareProfile"]>
    > | null = null,
    profileElapsed = 0;
  let initialPending = task.method === "initial_eda";
  const seenCalls = new Set<string>();
  const checkExecution = () => {
    if (o.signal?.aborted) throw new Stop("cancelled", "user_cancelled");
    if (signal.aborted || remaining() <= 0)
      throw new Stop("timed_out", "task_deadline");
    budget.checkExecution();
  };
  const check = () => {
    checkExecution();
    budget.check();
    if (budget.explorationMs() <= 0)
      throw new Stop("budget_exhausted", "exploration_reserve");
  };
  const agent = {
    remaining: { model_attempts: 0, executions: 0, tokens: 0, task_ms: 0 },
  };
  const update = () => {
    agent.remaining = {
      model_attempts: task.budget.model_attempts - budget.total.attempts,
      executions:
        task.budget.training_attempts === null
          ? Number.MAX_SAFE_INTEGER
          : task.budget.training_attempts - budget.training,
      tokens: task.budget.total_tokens - budget.total.total_tokens,
      task_ms: remaining(),
    };
  };
  const call = modelCaller({
    task,
    profile,
    client,
    recorder: {
      manifest: {},
      modelEvent: async (type, fields, content) => {
        await record.event(type, fields, content);
      },
    },
    tokens: budget.total,
    agent,
    signal,
    remainingTime: () => Math.min(remaining(), budget.explorationMs()),
    checkClock: check,
    updateRemaining: update,
    settle: (...args) => {
      budget.modeling.attempts++;
      budget.settleModel(...args);
    },
  });
  const messages: Message[] = [
    { role: "system", content: prompt },
    {
      role: "user",
      content: JSON.stringify({
        goal: task.goal,
        protocol: runtime.promptProtocol,
        resources: {
          model_attempts: task.budget.model_attempts,
          total_tokens: task.budget.total_tokens,
          task_timeout_ms: task.budget.task_timeout_ms,
          training_attempts: task.budget.training_attempts,
          final_reserve_ms: task.budget.final_reserve_ms,
        },
        execution_limits: {
          memory_bytes: task.limits.memory_bytes,
          workspace_bytes: task.limits.workspace_bytes,
          max_artifact_bytes: task.limits.max_artifact_bytes,
          max_artifacts_bytes: task.limits.max_artifacts_bytes,
        },
      }),
    },
  ];
  const view = () =>
    boundedState({
      best_experiment_id: best?.id ?? null,
      best_validation_score: best?.score ?? null,
      budget: budget.snapshot(),
      recovery: {
        policy: CORRECTION_POLICY,
        consecutive_rejections: corrections,
        corrections_remaining: Math.max(
          0,
          task.budget.action_corrections - corrections,
        ),
      },
      experiments: experiments
        .filter((e) => e.phase === "search")
        .map((e) => ({
          id: e.id,
          status: e.status,
          score: e.score,
          reason: e.reason,
        })),
      ...(task.method === "collaborative"
        ? { notes: notesHistory.at(-1) ?? null }
        : {}),
    });
  const state = () => ({
    status,
    reason,
    ended_at: status === "running" ? null : new Date().toISOString(),
    model,
    usage: budget.snapshot(),
    experiments,
    analyses,
    best_experiment_id: best?.id ?? null,
    search_best_experiment_id: best?.id ?? null,
    selected_experiment_id: selectedExperiment?.id ?? null,
    search_end: searchEnd,
    delivery: { status: deliveryStatus, artifact },
    confirmation,
    wall_ms: performance.now() - start,
    basic_profile: basicProfile,
    preparation: { profile_elapsed_ms: profileElapsed },
    notes_control:
      task.method === "collaborative"
        ? { version: 1, history: notesHistory }
        : "disabled",
  });
  const recordExperiment = async (e: Experiment<S>) => {
    experiments.push(e);
    for (const stage of [e.fit, e.predict, e.training_diagnostic?.prediction])
      if (stage)
        await record.event("child_result", {
          child_id: stage.run_id,
          experiment_id: e.id,
          status: stage.status,
        });
    await record.event("experiment_result", {
      experiment_id: e.id,
      status: e.status,
      score: e.score,
      reason: e.reason,
      evaluation: e.evaluation,
      phase: e.phase,
      training_diagnostic: e.training_diagnostic ?? null,
      source_search_experiment_id: e.source_search_experiment_id ?? null,
    });
  };
  const closeSearch = async (
    end: SearchEnd,
    acceptedSequence: number | null,
  ) => {
    checkExecution();
    if (searchEnd || !best || !executionConfirmed)
      throw new Error("Search cannot safely finalize");
    const candidates = shortlist(experiments, protocol, validationPlan);
    const count =
      (validationPlan.mode === "none"
        ? 0
        : candidates.length * validationPlan.confirmation.length) +
      task.budget.final_training_attempts;
    // Exploration already protects the reserve. Requiring its full nominal
    // duration again would reject the time trigger after ordinary bookkeeping.
    // Confirmation still protects final fitting; each stage uses the hard clock.
    if (
      (validationPlan.mode !== "none" && budget.confirmationMs() <= 0) ||
      (task.budget.training_attempts !== null &&
        budget.training + count > task.budget.training_attempts)
    )
      throw new Error("Insufficient closing execution reserve");
    const frozenSequence = await record.event("search_frozen", {
      origin: end.kind === "agent_finished" ? "model" : "host_protection",
      accepted_sequence: acceptedSequence,
      search_end: end,
      protection:
        end.kind === "protected"
          ? {
              tokens: budget.total,
              remaining_ms: remaining(),
              consecutive_unproductive: corrections,
              request_bytes: Buffer.byteLength(
                client.requestBody(
                  messages,
                  modelingTools(protocol, task.method),
                ),
              ),
            }
          : null,
      search_best_experiment_id: best.id,
      shortlist: candidates.map((e) => ({
        experiment_id: e.id,
        code_sha256: e.code_sha256,
      })),
    });
    searchEnd = end;
    deliveryStatus = "running";
    await record.save(state());
    const result = await finalizeExperiments({
      task,
      protocol,
      root: record.directory,
      signal,
      remaining,
      check: checkExecution,
      budget,
      plan: validationPlan,
      candidates,
      finalId: randomUUID(),
      executeExperiment: (candidate, evaluation, id, available) =>
        runtime.execute({
          task,
          root: record.directory,
          code: candidate.code,
          candidateId: candidate.candidate_id,
          signal,
          remaining: available,
          final: evaluation.phase === "final",
          evaluation,
          sourceSearchExperimentId: candidate.id,
          id,
          onStage: async (child) => {
            await record.event("child_intent", {
              child_id: child,
              experiment_id: id,
            });
          },
        }),
      onConfirmation: async (value) => {
        confirmation = value;
        selectedExperiment = candidates.find(
          (e) => e.id === value.selected_experiment_id,
        );
        await record.event("confirmation_result", {}, value);
        await record.save(state());
      },
      onIntent: async (id, candidate, evaluation, retry) => {
        executionConfirmed = false;
        await record.event("experiment_intent", {
          experiment_id: id,
          candidate_id: candidate.candidate_id,
          final: evaluation.phase === "final",
          phase: evaluation.phase,
          evaluation,
          source_search_experiment_id: candidate.id,
          frozen_sequence: frozenSequence,
          repair_of_experiment: null,
          retry,
        });
      },
      onStage: async (child, experiment) => {
        await record.event("child_intent", {
          child_id: child,
          experiment_id: experiment,
        });
      },
      onResult: async (e) => {
        await recordExperiment(e);
        executionConfirmed =
          !/kernel_lost|protocol_error|cleanup|record_failure|incomplete execution/.test(
            e.reason,
          );
        await record.save(state());
      },
    });
    checkExecution();
    selectedExperiment = result.selected;
    artifact = await runtime.deliver({
      root: record.directory,
      task,
      selected: result.selected,
      final: result.final,
      selection: {
        searchBest: best,
        confirmation: result.confirmation,
        plan: validationPlan,
      },
      signal,
      remaining,
      onFrozen: async (value) => {
        artifact = value;
        await record.event("model_frozen", {}, value);
        await record.save(state());
      },
      onPredictionStage: async (id) => {
        await record.event("child_intent", {
          child_id: id,
          purpose: "frozen_prediction",
        });
      },
      onPredictionResult: async (value) => {
        await record.event("frozen_prediction_result", {}, value);
        const prediction = obj(value);
        if (prediction.stage !== null && prediction.stage !== undefined) {
          const stage = obj(prediction.stage);
          await record.event("child_result", {
            child_id: stage.run_id,
            status: stage.status,
            purpose: "frozen_prediction",
          });
        }
      },
    });
    checkExecution();
    deliveryStatus =
      runtime.completion === "model_frozen"
        ? "pending_prediction"
        : "completed";
    status = runtime.completion ?? "completed";
    reason =
      runtime.completion === "model_frozen"
        ? "model_frozen"
        : "delivery_validated";
  };
  try {
    await record.event("run_started");
    await writeFile(
      join(record.directory, "validation-plan.json"),
      JSON.stringify(validationPlan),
      { flag: "wx", mode: 0o444 },
    );
    await record.save(state());
    const began = performance.now();
    try {
      basicProfile = await runtime.prepareProfile({
        root: record.directory,
        timeout_ms: remaining(),
        signal,
      });
    } finally {
      profileElapsed = performance.now() - began;
    }
    await record.event("basic_profile_completed", {
      artifact: basicProfile.artifact,
      elapsed_ms: profileElapsed,
    });
    messages.push({
      role: "user",
      content: JSON.stringify({
        basic_profile: basicProfile.profile,
        basic_profile_sha256: basicProfile.artifact.sha256,
        profile_source_examples: ["profile:/rows", "profile:/columns"],
      }),
    });
    await record.save(state());
    while (status === "running") {
      check();
      if (budget.explorationMs() <= 0)
        throw new Stop("budget_exhausted", "exploration_reserve");
      const hostInitial = initialPending;
      initialPending = false;
      let calls: NonNullable<
          Extract<Message, { role: "assistant" }>["tool_calls"]
        >,
        attemptId: string;
      if (hostInitial) {
        const request = {
          question: runtime.initialQuestion,
        };
        attemptId = "host-initial-eda-v2";
        await record.event(
          "initial_analysis_scheduled",
          { version: 2 },
          request,
        );
        calls = [
          {
            id: randomUUID(),
            type: "function",
            function: { name: "analyze", arguments: JSON.stringify(request) },
          },
        ];
      } else {
        await record.event(
          "model_context",
          { version: 1, method: task.method, ...contextIdentity(messages) },
          messages,
        );
        const response = await call(
          messages,
          modelingTools(protocol, task.method),
          model,
        );
        messages.push(response.response.message);
        calls = response.response.message.tool_calls ?? [];
        attemptId = response.attemptId;
      }
      let core: CoreAction,
        raw: Record<string, unknown>,
        allocation: ReturnType<Budget["hostChildBudget"]> | undefined;
      try {
        if (calls.length !== 1 || !calls[0] || seenCalls.has(calls[0].id))
          throw new Error("Exactly one new tool call is required");
        raw = obj(JSON.parse(calls[0].function.arguments));
        core = parseCore(
          calls[0].function.name,
          raw,
          task.limits.max_code_bytes,
          hostInitial ? "adaptive_eda" : task.method,
        );
        validateCore(core, experiments);
        if (core.kind === "analyze") allocation = budget.hostChildBudget();
        else budget.canTrain(core.kind === "finish");
      } catch (error) {
        if (error instanceof Stop) throw error;
        await record.event("action_rejected", {
          reason: String(error),
          correction_policy: CORRECTION_POLICY,
          consecutive_rejections: ++corrections,
        });
        if (corrections > task.budget.action_corrections)
          throw new Stop("failed", "action_corrections");
        for (const c of calls)
          messages.push({
            ...(hostInitial
              ? { role: "user" as const }
              : { role: "tool" as const, tool_call_id: c.id }),
            content: JSON.stringify({
              error: String(error),
              recovery_hint:
                "No action was executed. Correct core fields, choose a feasible action, or finish if a valid model exists.",
              ...view(),
            }),
          });
        if (!calls.length)
          messages.push({
            role: "user",
            content: "Use exactly one valid tool call.",
          });
        continue;
      }
      const tool = calls[0];
      if (!tool) throw new Error("Missing tool");
      seenCalls.add(tool.id);
      const operationId = randomUUID(),
        childId = randomUUID(),
        allocatedAt = Date.now(),
        childDeadline =
          performance.now() + (allocation?.effective.task_timeout_ms ?? 0);
      const accepted = acceptAttachments(
        core,
        raw,
        task.method,
        {
          run_id: record.id,
          profile: basicProfile.profile,
          profile_sha256: basicProfile.artifact.sha256,
          protocol,
          experiments,
          analyses,
        },
        notesHistory.at(-1) ?? null,
        record.nextSequence,
      );
      const intent =
        core.kind === "analyze"
          ? {
              kind: "analysis",
              analysis_id: operationId,
              child_id: childId,
              allocation,
              started_at: new Date(allocatedAt).toISOString(),
              deadline_at: new Date(
                allocatedAt + (allocation?.effective.task_timeout_ms ?? 0),
              ).toISOString(),
            }
          : core.kind === "train"
            ? {
                kind: "experiment",
                experiment_id: operationId,
                candidate_id: operationId,
                phase: "search",
                final: false,
                evaluation: validationPlan.search,
                source_experiment: core.source_experiment,
                repair_of_experiment: core.repair_of_experiment,
              }
            : { kind: "finish" };
      const seq = await record.event(
        "action_accepted",
        {
          protocol_version: 4,
          attempt_id: attemptId,
          origin: hostInitial ? "host_initial" : "model",
          tool_id: tool.id,
          tool_name: tool.function.name,
          intent,
        },
        { raw, accepted },
      );
      if (accepted.notes) notesHistory.push(accepted.notes);
      await record.save(state());
      checkExecution();
      if (core.kind === "finish") {
        await closeSearch({ kind: "agent_finished", reason: core.reason }, seq);
        break;
      }
      let feedback: unknown;
      executionConfirmed = false;
      if (core.kind === "analyze") {
        if (!allocation) throw new Error("Missing analysis allocation");
        await record.event("child_intent", {
          child_id: childId,
          analysis_id: operationId,
          allocation,
          accepted_sequence: seq,
        });
        budget.edaCalls++;
        const a = await runtime.analyze({
          id: operationId,
          runId: childId,
          root: record.directory,
          task,
          experiment:
            experiments.find((e) => e.id === core.source_experiments[0]) ??
            null,
          experiments: experiments.filter((e) =>
            core.source_experiments.includes(e.id),
          ),
          context: {
            version: 1,
            question: core.question,
            ...(task.method === "collaborative"
              ? { notes: notesHistory.at(-1) ?? null }
              : {}),
          },
          request: core,
          profile: edaProfile,
          signal,
          budget: allocation.effective,
          deadline: childDeadline,
          client: o.edaClient,
        });
        analyses.push(a);
        await record.event("child_result", {
          child_id: childId,
          analysis_id: operationId,
          status: a.status,
          dispatch: a.dispatch,
        });
        budget.settleChild(childId, a.cost, a.executions, a.role_usage);
        executionConfirmed = a.execution_confirmed === true;
        if (
          !executionConfirmed ||
          /cleanup|record_failure|kernel_lost|protocol_error/.test(a.reason)
        )
          throw new Stop("failed", `unconfirmed_eda:${a.reason}`);
        if (a.status === "completed") corrections = 0;
        else corrections++;
        feedback = {
          analysis_id: a.id,
          status: a.status,
          diagnostic: a.reason,
          source_experiments: a.source_experiments,
          analysis: a.analysis,
          sources: findingSources(a),
          allocation,
        };
      } else {
        budget.train(false);
        await record.event("experiment_intent", {
          ...intent,
          accepted_sequence: seq,
          retry: false,
        });
        const e = await runtime.execute({
          task,
          code: core.code,
          candidateId: operationId,
          root: record.directory,
          signal,
          remaining: () => Math.min(remaining(), budget.explorationMs()),
          final: false,
          evaluation: validationPlan.search,
          id: operationId,
          onStage: async (child) => {
            await record.event("child_intent", {
              child_id: child,
              experiment_id: operationId,
            });
          },
        });
        if (
          e.id !== operationId ||
          e.candidate_id !== operationId ||
          e.code !== core.code ||
          e.code_sha256 !== sha256(Buffer.from(core.code)) ||
          !e.evaluation ||
          e.phase !== "search" ||
          e.final
        )
          throw new Error("Unconfirmed search experiment identity");
        assertEvaluation(e.evaluation, validationPlan.search);
        if (e.status === "completed")
          validateEvaluationScore(e.score, protocol, validationPlan.search);
        else if (e.score !== null)
          throw new Error("Unexpected experiment score");
        await recordExperiment(e);
        // Preserve the validated result even when auxiliary execution prevents further work.
        if (
          e.status === "completed" &&
          e.score &&
          runtime.better(e.score, best?.score ?? null)
        )
          best = e;
        executionConfirmed =
          e.execution_confirmed !== false &&
          !/kernel_lost|protocol_error|cleanup|scoring_failure|record persistence|record_failure|incomplete execution/.test(
            e.reason,
          );
        if (!executionConfirmed) throw new Stop("failed", e.reason);
        if (e.status === "completed") {
          corrections = 0;
        } else corrections++;
        feedback = {
          experiment_id: e.id,
          status: e.status,
          score: e.score,
          training_diagnostic: e.training_diagnostic ?? null,
          diagnostic: e.reason,
          sources: [
            {
              source_id: `experiment:${e.id}:${e.status === "completed" ? "score" : "failure"}`,
            },
            ...(e.training_diagnostic?.status === "available"
              ? [{ source_id: `experiment:${e.id}:train_diagnostic` }]
              : []),
          ],
        };
      }
      messages.push({
        ...(hostInitial
          ? { role: "user" as const }
          : { role: "tool" as const, tool_call_id: tool.id }),
        content: JSON.stringify({
          ...view(),
          warnings: accepted.warnings,
          result: feedback,
        }),
      });
      await record.save(state());
      check();
      if (corrections > task.budget.action_corrections)
        throw new Stop("failed", "action_corrections");
    }
  } catch (error) {
    let e = error;
    if (
      e instanceof Stop &&
      protectedReasons.has(e.reason) &&
      !searchEnd &&
      best &&
      executionConfirmed &&
      !signal.aborted
    ) {
      try {
        await closeSearch({ kind: "protected", reason: e.reason }, null);
      } catch (closingError) {
        e = closingError;
      }
    }
    if (status !== "completed") {
      status = e instanceof Stop ? e.status : "failed";
      reason = e instanceof Stop ? e.reason : String(e);
      if (o.signal?.aborted) {
        status = "cancelled";
        reason = "user_cancelled";
      } else if (controller.signal.aborted) {
        status = "timed_out";
        reason = "task_deadline";
      }
      searchEnd ??= {
        kind: status === "cancelled" ? "cancelled" : "failed",
        reason,
      };
      if (["running"].includes(deliveryStatus))
        deliveryStatus = status === "cancelled" ? "cancelled" : "failed";
      if (reason.includes("record_failure")) recordError = true;
    }
  } finally {
    clearTimeout(timer);
    try {
      await record.event("run_finished", {
        status,
        reason,
        search_end: searchEnd,
        delivery_status: deliveryStatus,
      });
      await record.save(state());
    } catch (e) {
      recordError = true;
      status = "failed";
      reason = `record_failure:${String(e)}`;
    }
  }
  return {
    run_id: record.id,
    directory: record.directory,
    status,
    reason,
    best_experiment_id: best?.id ?? null,
    record_error: recordError,
  };
}
