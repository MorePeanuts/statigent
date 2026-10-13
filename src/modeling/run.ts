import { randomUUID } from "node:crypto";
import { modelCaller } from "../agent/model-call";
import { Stop } from "../agent/stop";
import { ChatClient, type Message, type ModelClient } from "../models/client";
import {
  type ModelProfile,
  profileSnapshot,
  validateProfile,
} from "../models/config";
import type { ModelMetadata } from "../records/agent-metadata";
import { sha256 } from "../records/store";
import {
  action,
  MODELING_PROMPT,
  MODELING_PROMPT_VERSION,
  MODELING_TOOLS,
  type ModelingAction,
} from "./actions";
import { Budget } from "./budget";
import {
  applyCandidateUpdates,
  attachExperiment,
  type CandidateState,
  candidateSummary,
  requireCandidate,
  validateRepair,
} from "./candidates";
import { validateModelingTask } from "./config";
import { loadDataset } from "./data";
import { deliver } from "./delivery";
import { type AnalysisRecord, analyze, validateEvidence } from "./eda";
import { type Experiment, runExperiment } from "./experiments";
import { ModelingRecord } from "./records";
export interface ModelingOptions {
  task: unknown;
  profile: ModelProfile;
  edaProfile: ModelProfile;
  runRoot: string;
  signal?: AbortSignal;
  client?: ModelClient;
  edaClient?: ModelClient;
  experiment?: typeof runExperiment;
  analysis?: typeof analyze;
  delivery?: typeof deliver;
  createRecord?: typeof ModelingRecord.create;
}
export async function runModeling(o: ModelingOptions) {
  const start = performance.now(),
    task = validateModelingTask(o.task),
    profile = validateProfile(o.profile),
    edaProfile = validateProfile(o.edaProfile);
  if (profile.id !== task.model_profile || edaProfile.id !== task.eda_profile)
    throw new Error("Profile/task mismatch");
  const data = await loadDataset(task.dataset_root);
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
  const budget = new Budget(task.budget, remaining);
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
        dataset: data.dataset,
        model: profileSnapshot(profile),
        eda_model: profileSnapshot(edaProfile),
        prompt: {
          version: MODELING_PROMPT_VERSION,
          sha256: sha256(Buffer.from(MODELING_PROMPT)),
        },
      },
      task.budget.max_trace_bytes,
    );
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  const experiments: Experiment[] = [],
    analyses: AnalysisRecord[] = [];
  let best: Experiment | undefined,
    status = "running",
    reason = "",
    delivery: Awaited<ReturnType<typeof deliver>> | null = null,
    recordError = false,
    corrections = 0,
    repairs = 0;
  let pendingAnalysis: string | null = null;
  let candidates: CandidateState[] = [];
  let appliedSequence = 0;
  const seenCalls = new Set<string>();
  const check = () => {
    if (o.signal?.aborted) throw new Stop("cancelled", "user_cancelled");
    if (signal.aborted || remaining() <= 0)
      throw new Stop("timed_out", "task_deadline");
    budget.check();
  };
  const agent = {
    remaining: { model_attempts: 0, executions: 0, tokens: 0, task_ms: 0 },
  };
  const update = () => {
    agent.remaining = {
      model_attempts: task.budget.model_attempts - budget.total.attempts,
      executions: task.budget.training_attempts - budget.training,
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
    remainingTime: remaining,
    checkClock: check,
    updateRemaining: update,
    settle: (...args) => {
      // A persisted request may still be cancelled before dispatch.
      budget.modeling.attempts++;
      budget.settleModel(...args);
    },
  });
  const messages: Message[] = [
    { role: "system", content: MODELING_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        goal: task.goal,
        protocol: {
          kind: data.dataset.kind,
          metric: data.dataset.metric,
          direction: data.dataset.direction,
          features: data.dataset.features,
          target: data.dataset.target,
          training_rows: data.dataset.split.train.length,
          validation_rows: data.dataset.split.validation.length,
        },
        budget: task.budget,
        execution_limits: {
          memory_bytes: task.limits.memory_bytes,
          workspace_bytes: task.limits.workspace_bytes,
          max_artifact_bytes: task.limits.max_artifact_bytes,
          max_artifacts_bytes: task.limits.max_artifacts_bytes,
        },
      }),
    },
  ];
  const view = () => ({
    best_experiment_id: best?.id ?? null,
    best_validation_rmse: best?.rmse ?? null,
    budget: budget.snapshot(),
    candidates: candidateSummary(candidates, experiments),
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
    delivery,
    wall_ms: performance.now() - start,
    candidate_control: {
      version: 1,
      candidates,
      applied_sequence: appliedSequence,
    },
  });
  const source = (id: string | null, requireSuccess = true) => {
    if (id === null) return null;
    const e = experiments.find((x) => x.id === id);
    if (!e || (requireSuccess && e.status !== "completed") || e.final)
      throw new Error("Invalid source experiment");
    return e;
  };
  try {
    await record.event("run_started");
    await record.save(state());
    while (true) {
      check();
      update();
      const response = await call(messages, MODELING_TOOLS, model);
      messages.push(response.response.message);
      const calls = response.response.message.tool_calls ?? [];
      let selected: ModelingAction;
      let nextCandidates: CandidateState[];
      try {
        if (calls.length !== 1 || !calls[0] || seenCalls.has(calls[0].id))
          throw new Error("Exactly one new tool call is required");
        selected = action(
          calls[0].function.name,
          calls[0].function.arguments,
          task.limits.max_code_bytes,
          task.budget.max_candidates,
        );
        for (const change of selected.candidate_updates)
          validateEvidence(change.evidence, analyses, data.dataset);
        nextCandidates = applyCandidateUpdates(
          candidates,
          selected.candidate_updates,
          task.budget.max_candidates,
        );
        if (selected.kind === "finish") {
          if (!best || best.id !== selected.experiment_id)
            throw new Error(
              "Finish must select current best successful experiment",
            );
        } else {
          source(selected.source_experiment, selected.kind === "analyze");
          if (selected.kind === "train") {
            requireCandidate(nextCandidates, selected.candidate_id, {
              active: true,
            });
            validateRepair(
              experiments,
              selected.candidate_id,
              selected.repair_of_experiment,
            );
            validateEvidence(selected.evidence, analyses, data.dataset);
            if (
              pendingAnalysis &&
              !selected.evidence.some((e) => e.analysis_id === pendingAnalysis)
            )
              throw new Error(
                "Follow-up training must link the returned analysis",
              );
          }
          if (selected.kind === "analyze")
            for (const id of selected.candidates)
              requireCandidate(nextCandidates, id, { active: true });
        }
      } catch (e) {
        if (e instanceof Stop) throw e;
        await record.event("action_rejected", { reason: String(e) });
        if (++corrections > task.budget.action_corrections)
          throw new Stop("failed", "action_corrections");
        for (const c of calls)
          messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: JSON.stringify({ error: String(e), ...view() }),
          });
        if (!calls.length)
          messages.push({
            role: "user",
            content: "Use exactly one valid tool call.",
          });
        continue;
      }
      const tool = calls[0];
      if (!tool) throw new Error("Missing validated tool");
      let allocation: ReturnType<Budget["childBudget"]> | undefined;
      try {
        if (selected.kind === "analyze")
          allocation = budget.childBudget(selected.requested_budget);
        else budget.canTrain(selected.kind === "finish");
      } catch (e) {
        if (e instanceof Stop) throw e;
        await record.event(
          "action_rejected",
          { reason: String(e), tool_id: tool.id },
          selected,
        );
        messages.push({
          role: "tool",
          tool_call_id: tool.id,
          content: JSON.stringify({ error: String(e), ...view() }),
        });
        continue;
      }
      const operationId = randomUUID(),
        childId = randomUUID();
      const final = selected.kind === "finish";
      const candidateId =
        selected.kind === "train" ? selected.candidate_id : best?.candidate_id;
      const repair =
        selected.kind === "train" ? selected.repair_of_experiment : null;
      const allocatedAt = Date.now();
      const deadline = allocation
        ? performance.now() + allocation.effective.task_timeout_ms
        : null;
      const intent =
        selected.kind === "analyze"
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
          : {
              kind: "experiment",
              experiment_id: operationId,
              candidate_id: candidateId,
              final,
              repair_of_experiment: repair,
            };
      seenCalls.add(tool.id);
      const acceptedSequence = await record.event(
        "action_accepted",
        {
          protocol_version: 2,
          attempt_id: response.attemptId,
          tool_id: tool.id,
          intent,
        },
        selected,
      );
      candidates = nextCandidates;
      if (selected.kind !== "analyze") {
        if (!candidateId) throw new Error("Missing accepted candidate");
        candidates = attachExperiment(candidates, candidateId, operationId);
      }
      appliedSequence = acceptedSequence;
      await record.save(state());
      check();
      let feedback: unknown;
      if (selected.kind === "analyze") {
        if (!allocation || deadline === null)
          throw new Error("Missing accepted allocation");
        const id = operationId;
        await record.event("child_intent", {
          child_id: childId,
          analysis_id: id,
          allocation,
          accepted_sequence: acceptedSequence,
        });
        budget.edaCalls++;
        let a: AnalysisRecord;
        try {
          a = await (o.analysis ?? analyze)({
            id,
            runId: childId,
            root: record.directory,
            task,
            dataset: data.dataset,
            train: data.train,
            experiment: source(selected.source_experiment),
            request: selected,
            resolvedCandidates: selected.candidates.map((id) =>
              requireCandidate(candidates, id),
            ),
            profile: edaProfile,
            signal,
            budget: allocation.effective,
            deadline,
            client: o.edaClient,
          });
        } catch (e) {
          budget.total.status = "unknown";
          throw new Stop("failed", `unconfirmed_eda:${String(e)}`);
        }
        analyses.push(a);
        if (a.status === "completed" && a.analysis) pendingAnalysis = a.id;
        await record.event("child_result", {
          child_id: childId,
          analysis_id: id,
          status: a.status,
          dispatch: a.dispatch,
        });
        budget.settleChild(childId, a.cost, a.executions, a.role_usage);
        if (/cleanup|record_failure/.test(a.reason))
          throw new Stop("failed", a.reason);
        check();
        feedback = {
          analysis_id: id,
          status: a.status,
          diagnostic: a.reason,
          source_experiment: a.source_experiment,
          analysis: a.analysis,
          allocation,
        };
      } else {
        budget.train(final);
        const code = selected.kind === "train" ? selected.code : best?.code;
        if (!code) throw new Error("Missing candidate code");
        let e: Experiment;
        let id = operationId;
        let retry = false;
        while (true) {
          if (!candidateId) throw new Error("Missing accepted candidate");
          const sequence = await record.event("experiment_intent", {
            experiment_id: id,
            candidate_id: candidateId,
            final,
            accepted_sequence: acceptedSequence,
            repair_of_experiment: repair,
            retry,
          });
          if (retry) {
            candidates = attachExperiment(candidates, candidateId, id);
            appliedSequence = sequence;
            await record.save(state());
          }
          e = await (o.experiment ?? runExperiment)({
            task,
            ...data,
            code,
            candidateId,
            root: record.directory,
            signal,
            remaining: final
              ? remaining
              : () => Math.min(remaining(), budget.explorationMs()),
            final,
            id,
            onStage: async (childId) => {
              await record.event("child_intent", {
                child_id: childId,
                experiment_id: id,
              });
            },
          });
          experiments.push(e);
          if (!final) pendingAnalysis = null;
          for (const s of [e.fit, e.predict])
            if (s)
              await record.event("child_result", {
                child_id: s.run_id,
                experiment_id: id,
                status: s.status,
              });
          await record.event("experiment_result", {
            experiment_id: id,
            status: e.status,
            rmse: e.rmse,
            reason: e.reason,
          });
          check();
          if (
            e.status !== "completed" &&
            /^(kernel_lost|protocol_error|cleanup):|record persistence|record_failure|incomplete execution/.test(
              e.reason,
            )
          )
            throw new Stop("failed", e.reason);
          if (
            final &&
            e.status !== "completed" &&
            e.reason.startsWith("error:") &&
            budget.finalTraining < task.budget.final_training_attempts
          ) {
            budget.train(true);
            id = randomUUID();
            retry = true;
            continue;
          }
          break;
        }
        if (final) {
          if (e.status !== "completed" || !best)
            throw new Stop("failed", `finalization_failed:${e.reason}`);
          delivery = await (o.delivery ?? deliver)(
            record.directory,
            task,
            best,
            e,
            data.dataset,
          );
          check();
          status = "completed";
          reason = "delivery_validated";
          break;
        }
        if (
          e.status === "completed" &&
          e.rmse !== null &&
          (!best || e.rmse < (best.rmse ?? Infinity))
        )
          best = e;
        if (e.status !== "completed" && ++repairs > task.budget.code_repairs)
          throw new Stop("failed", "training_repairs");
        feedback = {
          experiment_id: e.id,
          status: e.status,
          rmse: e.rmse,
          diagnostic: e.reason,
        };
      }
      messages.push({
        role: "tool",
        tool_call_id: tool.id,
        content: JSON.stringify({ ...view(), result: feedback }),
      });
      await record.save(state());
    }
  } catch (e) {
    status = e instanceof Stop ? e.status : "failed";
    reason = e instanceof Stop ? e.reason : String(e);
    if (o.signal?.aborted) {
      status = "cancelled";
      reason = "user_cancelled";
    } else if (controller.signal.aborted) {
      status = "timed_out";
      reason = "task_deadline";
    }
    if (reason.includes("record_failure")) recordError = true;
  } finally {
    clearTimeout(timer);
    try {
      await record.event("run_finished", { status, reason });
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
