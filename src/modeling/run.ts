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
  MODELING_PROMPT_VERSION,
  type ModelingAction,
  modelingPrompt,
  modelingTools,
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
import { datasetProtocol, loadDataset } from "./data";
import { deliver } from "./delivery";
import { type AnalysisRecord, analyze, validateEvidence } from "./eda";
import { type Experiment, runExperiment } from "./experiments";
import {
  applyKnowledgeUpdates,
  type KnowledgeRevision,
  requireKnowledge,
} from "./knowledge";
import {
  validateKnowledgeLinks,
  validateKnowledgeSources,
} from "./knowledge-sources";
import { createBasicProfile } from "./profile";
import {
  analysisContext,
  CONTEXT_LIMITS,
  contextIdentity,
  knowledgeView,
} from "./prompt";
import { better, validateScore } from "./protocol";
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
  prepareProfile?: typeof createBasicProfile;
}
export async function runModeling(o: ModelingOptions) {
  const start = performance.now(),
    task = validateModelingTask(o.task),
    profile = validateProfile(o.profile),
    edaProfile = validateProfile(o.edaProfile);
  if (profile.id !== task.model_profile || edaProfile.id !== task.eda_profile)
    throw new Error("Profile/task mismatch");
  const data = await loadDataset(task.dataset_root);
  const protocol = datasetProtocol(data.dataset);
  const prompt = modelingPrompt(task.method);
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
        protocol,
        model: profileSnapshot(profile),
        eda_model: profileSnapshot(edaProfile),
        prompt: {
          context_limits: CONTEXT_LIMITS,
          version: MODELING_PROMPT_VERSION,
          sha256: sha256(Buffer.from(prompt)),
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
  let knowledge: KnowledgeRevision[] = [];
  let candidates: CandidateState[] = [];
  let basicProfile: Awaited<ReturnType<typeof createBasicProfile>> | null =
    null;
  let profileElapsed = 0;
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
    { role: "system", content: prompt },
    {
      role: "user",
      content: JSON.stringify({
        goal: task.goal,
        protocol: {
          ...protocol,
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
    best_validation_score: best?.score ?? null,
    budget: budget.snapshot(),
    candidates: candidateSummary(candidates, experiments),
    ...(task.method === "collaborative"
      ? {
          knowledge: knowledgeView(
            knowledge,
            [],
            candidates,
            best?.candidate_id,
          ),
        }
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
    delivery,
    wall_ms: performance.now() - start,
    basic_profile: basicProfile,
    preparation: { profile_elapsed_ms: profileElapsed },
    knowledge_control:
      task.method === "collaborative"
        ? { version: 1, history: knowledge, applied_sequence: appliedSequence }
        : "disabled",
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
    const profileStarted = performance.now();
    try {
      basicProfile = await (o.prepareProfile ?? createBasicProfile)({
        root: record.directory,
        dataset: data.dataset,
        train: data.train,
        timeout_ms: remaining(),
        signal,
      });
    } finally {
      profileElapsed = performance.now() - profileStarted;
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
      }),
    });
    await record.save(state());
    while (true) {
      check();
      update();
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
      const calls = response.response.message.tool_calls ?? [];
      let selected: ModelingAction;
      let nextCandidates: CandidateState[];
      let nextKnowledge: KnowledgeRevision[];
      let nextContext: ReturnType<typeof analysisContext> | undefined;
      try {
        if (calls.length !== 1 || !calls[0] || seenCalls.has(calls[0].id))
          throw new Error("Exactly one new tool call is required");
        selected = action(
          calls[0].function.name,
          calls[0].function.arguments,
          task.limits.max_code_bytes,
          task.budget.max_candidates,
          task.method,
        );
        for (const change of selected.candidate_updates)
          validateEvidence(
            change.evidence,
            analyses,
            data.dataset,
            experiments,
          );
        nextCandidates = applyCandidateUpdates(
          candidates,
          selected.candidate_updates,
          task.budget.max_candidates,
          task.method === "collaborative",
        );
        const scope = {
          run_id: record.id,
          dataset_sha256: data.dataset.files[0]?.sha256 ?? "",
          protocol_sha256: protocol.protocol_sha256,
        };
        const updates = selected.knowledge_updates ?? [];
        validateKnowledgeSources(updates, {
          scope,
          profile: basicProfile.profile,
          profile_sha256: basicProfile.artifact.sha256,
          protocol,
          experiments: experiments.map((e) => ({
            id: e.id,
            scope,
            status: e.status,
            phase: e.final ? "final" : "search",
            score: e.score,
            reason: e.reason,
            prediction_sha256: e.predict?.output?.sha256 ?? null,
          })),
          analyses: analyses.map((a) => ({
            id: a.id,
            scope,
            status: a.status,
            analysis: a.analysis,
            source_sha256: a.source_sha256 ?? "",
            sources: a.source_experiments ?? [],
          })),
        });
        nextKnowledge = applyKnowledgeUpdates(
          knowledge,
          updates,
          scope,
          record.nextSequence,
        );
        validateKnowledgeLinks(nextKnowledge, nextCandidates);
        for (const ref of selected.knowledge_refs ?? [])
          requireKnowledge(nextKnowledge, ref);
        if (selected.kind === "analyze")
          nextContext = analysisContext({
            question: selected.question,
            candidates: selected.candidates.map((id) =>
              requireCandidate(nextCandidates, id),
            ),
            history: task.method === "collaborative" ? nextKnowledge : [],
            refs: selected.knowledge_refs ?? [],
            bestCandidate: best?.candidate_id,
          });
        if (selected.kind === "finish") {
          if (!best || best.id !== selected.experiment_id)
            throw new Error(
              "Finish must select current best successful experiment",
            );
        } else {
          if (selected.kind === "analyze")
            for (const id of selected.source_experiments) source(id);
          else source(selected.source_experiment, false);
          if (selected.kind === "train") {
            requireCandidate(nextCandidates, selected.candidate_id, {
              active: true,
            });
            validateRepair(
              experiments,
              selected.candidate_id,
              selected.repair_of_experiment,
            );
            validateEvidence(
              selected.evidence,
              analyses,
              data.dataset,
              experiments,
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
      let allocation: ReturnType<Budget["hostChildBudget"]> | undefined;
      try {
        if (selected.kind === "analyze") allocation = budget.hostChildBudget();
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
          protocol_version: 3,
          attempt_id: response.attemptId,
          tool_id: tool.id,
          intent,
        },
        selected,
      );
      candidates = nextCandidates;
      knowledge = nextKnowledge;
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
            experiment: source(selected.source_experiments[0] ?? null),
            experiments: selected.source_experiments.map((id) => {
              const e = source(id);
              if (!e) throw new Error("Missing analysis source");
              return e;
            }),
            context: nextContext,
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
          source_experiments: a.source_experiments,
          source_sha256: a.source_sha256,
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
          if (e.status === "completed" && !e.final)
            validateScore(e.score, protocol);
          else if (e.score !== null)
            throw new Error("Unexpected experiment score");
          experiments.push(e);
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
            score: e.score,
            reason: e.reason,
          });
          // A confirmed score remains selectable even if the following clock check stops exploration.
          if (
            !e.final &&
            e.status === "completed" &&
            e.score &&
            better(e.score, best?.score ?? null)
          )
            best = e;
          check();
          if (
            e.status !== "completed" &&
            /^(kernel_lost|protocol_error|cleanup|scoring_failure):|record persistence|record_failure|incomplete execution/.test(
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
        if (e.status !== "completed" && ++repairs > task.budget.code_repairs)
          throw new Stop("failed", "training_repairs");
        feedback = {
          experiment_id: e.id,
          status: e.status,
          score: e.score,
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
