import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExecutionResult, SessionConfig } from "../execution/protocol";
import { DockerSession } from "../execution/session";
import {
  ChatClient,
  type Message,
  type ModelClient,
  type Usage,
} from "../models/client";
import {
  type ModelProfile,
  profileSnapshot,
  validateProfile,
} from "../models/config";
import {
  type AgentMetadata,
  type AgentRole,
  type CollaborationRecord,
  emptyLedger,
  type ModelMetadata,
  type RoleRecord,
  type SubtaskRecord,
  type TokenLedger,
} from "../records/agent-metadata";
import { exportNotebooks } from "../records/notebook";
import { RunRecorder, readManifest, sha256, writeJson } from "../records/store";
import {
  type Analysis,
  renderAnalysis,
  tools,
  validateAction,
} from "./actions";
import {
  type RoleAction,
  roleTools,
  validateRoleAction,
} from "./collaboration-actions";
import {
  ROLE_PROMPT_VERSIONS,
  ROLE_PROMPTS,
  roleInitialMessages,
} from "./collaboration-prompt";
import {
  type ReturnedImage,
  returnedImages,
  validatePlannerReport,
} from "./collaboration-report";
import { type AgentTask, preflightInputs, validateTask } from "./config";
import { modelCaller } from "./model-call";
import { initialMessages, promptVersion, SYSTEM_PROMPT } from "./prompt";
import type { AnalysisReport } from "./report";
import { resolveReport } from "./report";
import { Stop } from "./stop";
export type AgentStatus =
  | "completed"
  | "budget_exhausted"
  | "timed_out"
  | "cancelled"
  | "failed";
export interface AgentSession {
  execute(
    code: string,
    options: { requestId: string },
  ): Promise<ExecutionResult>;
  cancel(requestId: string): Promise<unknown>;
  close(): Promise<void>;
  readonly closeResult?: { status: string; cleanup_error?: string };
}
export interface RunOptions {
  task: unknown;
  profile: ModelProfile;
  runRoot: string;
  signal?: AbortSignal;
  client?: ModelClient;
  createSession?: (
    config: SessionConfig,
    recorder: RunRecorder,
  ) => Promise<AgentSession>;
  export?: typeof exportNotebooks;
  createRecorder?: typeof RunRecorder.create;
}
export interface AgentResult {
  run_id: string;
  directory: string;
  status: AgentStatus;
  reason: string;
  analysis: Analysis | null;
  record_error: boolean;
}
export async function runAgent(options: RunOptions): Promise<AgentResult> {
  const began = performance.now();
  const task: AgentTask = validateTask(options.task);
  const profile = validateProfile(options.profile);
  const client = options.client ?? new ChatClient(profile);
  if (
    JSON.stringify(profileSnapshot(client.profile)) !==
    JSON.stringify(profileSnapshot(profile))
  )
    throw new Error("Client/profile mismatch");
  await preflightInputs(task);
  const deadline = began + task.budget.task_timeout_ms;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const remainingTime = () =>
    Math.max(0, Math.floor(deadline - performance.now()));
  const timer = setTimeout(() => controller.abort(), remainingTime());
  const runId = randomUUID();
  const config: SessionConfig = {
    ...task.execution,
    run_id: runId,
    staging_root: resolve(options.runRoot, ".staging"),
    limits: {
      ...task.execution.limits,
      task_timeout_ms: Math.max(1, remainingTime()),
      startup_timeout_ms: Math.max(
        1,
        Math.min(task.execution.limits.startup_timeout_ms, remainingTime()),
      ),
    },
  };
  const tokens: TokenLedger = {
    status: "known",
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    attempts: 0,
    unknown_attempts: 0,
    elapsed_ms: 0,
    currency_cost: "not_computed",
  };
  const model: ModelMetadata = {
    profile: profileSnapshot(profile),
    returned_models: [],
    response_ids: [],
    fingerprints: [],
  };
  const agent: AgentMetadata = {
    goal: task.goal,
    constraints: task.constraints,
    budget: task.budget,
    remaining: {
      model_attempts: task.budget.model_attempts,
      executions: task.budget.executions,
      tokens: task.budget.total_tokens,
      task_ms: remainingTime(),
    },
    executions: 0,
    termination: null,
    final_result: null,
    trace_bytes: 0,
    trace_incomplete: false,
  };
  const roleRecord = (role: AgentRole): RoleRecord => ({
    model: {
      profile: profileSnapshot(profile),
      returned_models: [],
      response_ids: [],
      fingerprints: [],
    },
    prompt: {
      version: ROLE_PROMPT_VERSIONS[role],
      sha256: sha256(Buffer.from(ROLE_PROMPTS[role])),
    },
    tokens: emptyLedger(),
  });
  const collaboration: CollaborationRecord | undefined =
    task.organization === "planner-executor"
      ? {
          organization: "planner-executor",
          roles: {
            planner: roleRecord("planner"),
            executor: roleRecord("executor"),
          },
          subtasks: [],
        }
      : undefined;
  let role: AgentRole = "planner";
  let subtask: SubtaskRecord | undefined;
  const identity = () =>
    collaboration
      ? { role, subtask_id: subtask?.subtask_id ?? null }
      : undefined;
  let recorder: RunRecorder;
  try {
    recorder = await (options.createRecorder ?? RunRecorder.create)({
      runRoot: options.runRoot,
      runId,
      config: { ...config },
      inputs: [],
      image: { id: "unresolved", platform: "unresolved" },
      seed: config.seed,
      maxArtifactBytes: config.limits.max_artifact_bytes,
      maxTotalArtifactBytes:
        config.limits.max_artifacts_bytes + config.limits.max_output_bytes,
      agent: {
        model,
        collaboration,
        tokens,
        metadata: agent,
        prompt: {
          version: collaboration ? "eda-collaboration-v1" : promptVersion(task),
          sha256: sha256(
            Buffer.from(
              collaboration ? JSON.stringify(ROLE_PROMPTS) : SYSTEM_PROMPT,
            ),
          ),
        },
      },
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  let session: AgentSession | undefined;
  let active: string | undefined;
  let abortWork: Promise<unknown> | undefined;
  const onAbort = () => {
    if (session)
      abortWork = (active ? session.cancel(active) : session.close()).catch(
        () => {
          /* close is checked again in finalization */
        },
      );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const checkClock = () => {
    if (options.signal?.aborted) throw new Stop("cancelled", "user_cancelled");
    if (controller.signal.aborted || remainingTime() === 0)
      throw new Stop("timed_out", "task_deadline");
  };
  const updateRemaining = () => {
    agent.remaining = {
      model_attempts: Math.max(0, task.budget.model_attempts - tokens.attempts),
      executions: Math.max(0, task.budget.executions - agent.executions),
      tokens: Math.max(0, task.budget.total_tokens - tokens.total_tokens),
      task_ms: remainingTime(),
    };
  };
  const settle = (usage: Usage, unknown: boolean, elapsed: number) => {
    const ledgers = [
      tokens,
      ...(collaboration ? [collaboration.roles[role].tokens] : []),
      ...(subtask ? [subtask.tokens] : []),
    ];
    for (const ledger of ledgers) {
      ledger.elapsed_ms += elapsed;
      ledger.input_tokens += usage.input_tokens ?? 0;
      ledger.output_tokens += usage.output_tokens ?? 0;
      ledger.total_tokens = ledger.input_tokens + ledger.output_tokens;
      if (unknown) {
        ledger.status = "unknown";
        ledger.unknown_attempts++;
      }
    }
    updateRemaining();
  };
  const callModel = modelCaller({
    task,
    profile,
    client,
    recorder,
    tokens,
    agent,
    signal,
    remainingTime,
    checkClock,
    updateRemaining,
    settle,
  });
  const singleMessages = initialMessages(task);
  const histories: Record<AgentRole, Message[]> = {
    planner: roleInitialMessages(task, "planner"),
    executor: roleInitialMessages(task, "executor"),
  };
  const visibleEvidence = new Set<string>();
  const visibleImages = new Map<string, ReturnedImage>();
  const seenIds = new Set<string>();
  const evidence = new Set<string>();
  let successes = 0;
  let codeErrors = 0;
  let corrections = 0;
  let status: AgentStatus = "failed";
  let reason = "not_finished";
  let analysis: Analysis | null = null;
  let recordError = false;
  try {
    checkClock();
    session = await (options.createSession ?? DockerSession.create)(
      config,
      recorder,
    );
    checkClock();
    for (;;) {
      const messages = collaboration ? histories[role] : singleMessages;
      const toolSet = collaboration
        ? roleTools(role, task.report !== null)
        : tools(task.report !== null);
      checkClock();
      updateRemaining();
      const { attemptId, response } = await callModel(
        messages,
        toolSet,
        model,
        identity(),
      );
      const calls = response.message.tool_calls ?? [];
      for (const call of calls) {
        if (seenIds.has(call.id)) throw new Stop("failed", "duplicate_tool_id");
        seenIds.add(call.id);
      }
      messages.push(response.message);
      let action: RoleAction | undefined;
      let reportImages: AnalysisReport["images"] | undefined;
      let invalid: string | undefined;
      try {
        if (calls.length !== 1)
          throw new Error("Exactly one tool action required");
        const call = calls[0];
        if (!call) throw new Error("Missing tool");
        action = collaboration
          ? validateRoleAction(
              role,
              call.function.name,
              call.function.arguments,
              role === "planner" ? visibleEvidence : evidence,
              successes,
              config.limits.max_code_bytes,
              subtask?.subtask_id ?? null,
              task.report !== null,
            )
          : validateAction(
              call.function.name,
              call.function.arguments,
              evidence,
              successes,
              config.limits.max_code_bytes,
              task.report !== null,
            );
        // Report checks read saved artifacts, so they run here rather than in the pure validator.
        if (
          action.kind === "finish" &&
          task.report &&
          action.report_artifact_id
        )
          action.analysis.report = await resolveReport(
            recorder.directory,
            recorder.manifest.artifacts,
            action.report_artifact_id,
            task.report,
          );
        if (
          action.kind === "finish" &&
          collaboration &&
          task.report &&
          action.report_markdown
        ) {
          recorder.validateReportSize(
            Buffer.byteLength(action.report_markdown),
          );
          reportImages = await validatePlannerReport(
            action.report_markdown,
            recorder.directory,
            recorder.manifest.artifacts,
            visibleImages,
            task.report,
          );
        }
      } catch (error) {
        invalid = error instanceof Error ? error.message : "Invalid action";
      }
      await recorder.modelEvent("tool_validation", {
        ...identity(),
        attempt_id: attemptId,
        tool_ids: calls.map((c) => c.id),
        valid: !invalid,
        diagnostic: invalid ?? null,
      });
      if (invalid || !action) {
        corrections++;
        if (corrections > task.budget.action_corrections)
          throw new Stop("failed", "action_corrections_exhausted");
        for (const call of calls)
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              status: "rejected",
              diagnostic: invalid,
            }),
          });
        if (!calls.length)
          messages.push({
            role: "user",
            content: "No action executed. Use exactly one allowed tool call.",
          });
        continue;
      }
      checkClock();
      if (action.kind === "delegate") {
        if (!collaboration || role !== "planner" || subtask)
          throw new Stop("failed", "invalid_delegation_state");
        const call = calls[0];
        if (!call) throw new Stop("failed", "missing_tool");
        subtask = {
          subtask_id: randomUUID(),
          tool_id: call.id,
          status: "running",
          tokens: emptyLedger(),
          evidence_refs: [],
        };
        collaboration.subtasks.push(subtask);
        await recorder.modelEvent(
          "subtask_delegated",
          {
            role: "planner",
            subtask_id: subtask.subtask_id,
            tool_id: call.id,
            attempt_id: attemptId,
          },
          action,
        );
        histories.executor.push({
          role: "user",
          content: JSON.stringify({
            subtask_id: subtask.subtask_id,
            task: action.task,
            constraints: action.constraints,
            remaining: agent.remaining,
            execution_context: {
              backend: "persistent-kernel",
              session_continues: collaboration.subtasks.length > 1,
              prior_subtasks: collaboration.subtasks.length - 1,
              prior_executions: agent.executions,
            },
          }),
        });
        role = "executor";
        continue;
      }
      if (action.kind === "return") {
        if (!collaboration || role !== "executor" || !subtask)
          throw new Stop("failed", "invalid_return_state");
        subtask.status = action.result.status;
        subtask.evidence_refs = [
          ...new Set(action.result.findings.flatMap((f) => f.evidence_refs)),
        ];
        for (const ref of subtask.evidence_refs) visibleEvidence.add(ref);
        const images = await returnedImages(
          recorder.directory,
          recorder.manifest.artifacts,
          subtask.evidence_refs,
        );
        for (const image of images) visibleImages.set(image.reference, image);
        const feedback = {
          ...action.result,
          images,
          remaining: agent.remaining,
        };
        await recorder.modelEvent(
          "subtask_returned",
          { ...identity(), tool_id: calls[0]?.id, attempt_id: attemptId },
          feedback,
        );
        messages.push({
          role: "tool",
          tool_call_id: calls[0]?.id ?? "",
          content: JSON.stringify({
            status: "accepted",
            remaining: agent.remaining,
          }),
        });
        histories.planner.push({
          role: "tool",
          tool_call_id: subtask.tool_id,
          content: JSON.stringify(feedback),
        });
        role = "planner";
        subtask = undefined;
        continue;
      }
      if (action.kind === "finish") {
        if (collaboration)
          await recorder.modelEvent(
            "analysis_submitted",
            { ...identity(), attempt_id: attemptId, tool_id: calls[0]?.id },
            action,
          );
        if (collaboration && action.report_markdown && reportImages) {
          const call = calls[0];
          if (!call) throw new Stop("failed", "missing_tool");
          const report = await recorder.savePlannerReport(
            action.report_markdown,
            { role: "planner", attempt_id: attemptId, tool_id: call.id },
          );
          action.analysis.report = {
            artifact_id: report.artifact_id,
            source_path: "report.md",
            images: reportImages,
          };
        }
        analysis = action.analysis;
        await writeJson(join(recorder.directory, "analysis.json"), {
          run_id: runId,
          ...analysis,
        });
        await writeFile(
          join(recorder.directory, "analysis.md"),
          renderAnalysis(analysis, runId),
          { flag: "wx", mode: 0o600 },
        );
        agent.final_result = "analysis.json";
        status = "completed";
        reason = "analysis_accepted";
        break;
      }
      if (agent.executions >= task.budget.executions)
        throw new Stop("budget_exhausted", "executions");
      const requestId = randomUUID();
      const call = calls[0];
      if (!call) throw new Stop("failed", "missing_tool");
      await recorder.modelEvent("tool_validation", {
        ...identity(),
        attempt_id: attemptId,
        tool_id: call.id,
        request_id: requestId,
        dispatched: true,
      });
      checkClock();
      active = requestId;
      let result: ExecutionResult;
      try {
        result = await session.execute(action.code, { requestId });
      } finally {
        active = undefined;
      }
      if (result.started) agent.executions++;
      if (
        result.status === "ok" &&
        result.started &&
        result.persistence_complete
      ) {
        successes++;
        codeErrors = 0;
        evidence.add(result.cell_id);
      }
      for (const ref of result.artifacts)
        if (
          ref.complete &&
          recorder.manifest.artifacts.some(
            (r) => r.artifact_id === ref.artifact_id && r.complete,
          )
        )
          evidence.add(ref.artifact_id);
      updateRemaining();
      // Only executed feedback, never host paths or privileged tools. Images are references, not visual input.
      const feedback = {
        ...result,
        artifacts: result.artifacts.map(
          ({ artifact_id, mime_type, complete }) => ({
            artifact_id,
            mime_type,
            complete,
            visually_observed: false,
          }),
        ),
        evidence_refs: [...evidence],
        ...(collaboration ? { remaining: agent.remaining } : {}),
      };
      await recorder.modelEvent(
        "tool_validation",
        {
          ...identity(),
          attempt_id: attemptId,
          tool_id: call.id,
          request_id: requestId,
          cell_id: result.cell_id,
        },
        feedback,
      );
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(feedback),
      });
      checkClock();
      if (
        !result.kernel_available ||
        !result.persistence_complete ||
        !result.started
      )
        throw new Stop("failed", "execution_state_unavailable");
      if (result.status === "error") {
        codeErrors++;
        if (codeErrors > task.budget.code_repairs)
          throw new Stop("failed", "code_repairs_exhausted");
      } else if (result.status !== "ok")
        throw new Stop(
          result.status === "timed_out"
            ? "timed_out"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed",
          `execution_${result.status}`,
        );
    }
  } catch (error) {
    if (options.signal?.aborted) {
      status = "cancelled";
      reason = "user_cancelled";
    } else if (controller.signal.aborted || remainingTime() === 0) {
      status = "timed_out";
      reason = "task_deadline";
    } else if (error instanceof Stop) {
      status = error.status;
      reason = error.reason;
    } else {
      status = "failed";
      reason = "runtime_or_record_failure";
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await abortWork;
    if (session)
      try {
        await session.close();
        if (
          session.closeResult?.status !== "ok" ||
          session.closeResult.cleanup_error
        ) {
          if (status === "completed") status = "failed";
          reason += ";cleanup_incomplete";
        }
      } catch {
        status = "failed";
        reason += ";cleanup_failed";
      }
  }
  agent.termination = reason;
  updateRemaining();
  try {
    recorder.manifest.status = "finalizing";
    await recorder.saveManifest();
    await (options.export ?? exportNotebooks)(
      recorder.directory,
      undefined,
      status,
    );
    const exported = await readManifest(recorder.directory);
    recorder.manifest.export = exported.export;
    recorder.manifest.replay = exported.replay;
  } catch {
    status = "failed";
    reason += ";export_or_record_failed";
  }
  agent.termination = reason;
  try {
    await recorder.modelEvent("agent_finish", {
      ...identity(),
      status,
      reason,
    });
    await recorder.finish(status);
    if (recorder.manifest.status !== status && status === "completed") {
      status = "failed";
      reason = "execution_cleanup_failed";
    }
  } catch {
    status = "failed";
    reason += ";record_failed";
    recordError = true;
  }
  return {
    run_id: runId,
    directory: recorder.directory,
    status,
    reason,
    analysis,
    record_error: recordError,
  };
}
