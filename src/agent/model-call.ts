import { randomUUID } from "node:crypto";
import {
  type Message,
  type ModelClient,
  ModelFailure,
  type ModelResponse,
  type Usage,
} from "../models/client";
import type { ModelProfile } from "../models/config";
import type {
  AgentMetadata,
  AgentRole,
  CollaborationRecord,
  ModelMetadata,
  TokenLedger,
} from "../records/agent-metadata";
import type { RunRecorder } from "../records/store";
import type { AgentTask } from "./config";
import { Stop } from "./stop";
export interface CallContext {
  task: Pick<AgentTask, "budget">;
  profile: ModelProfile;
  client: ModelClient;
  recorder: Pick<RunRecorder, "modelEvent"> & {
    manifest: { collaboration?: CollaborationRecord };
  };
  tokens: TokenLedger;
  agent: Pick<AgentMetadata, "remaining">;
  signal: AbortSignal;
  remainingTime: () => number;
  checkClock: () => void;
  updateRemaining: () => void;
  settle: (usage: Usage, unknown: boolean, elapsed: number) => void;
}
/** Retries consume the same task budget across role switches. */
export function modelCaller(context: CallContext) {
  const {
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
  } = context;
  let rateRetries = 0;
  return async (
    messages: Message[],
    toolSet: readonly unknown[],
    model: ModelMetadata,
    identity?: { role: AgentRole; subtask_id: string | null },
  ) => {
    for (;;) {
      checkClock();
      updateRemaining();
      if (tokens.attempts >= task.budget.model_attempts)
        throw new Stop("budget_exhausted", "model_attempts");
      let body = client.requestBody(messages, toolSet);
      let estimate = Buffer.byteLength(body);
      if (estimate > task.budget.max_request_bytes)
        throw new Stop("budget_exhausted", "request_size_limit");
      // 输入仍用保守字节估计；profile 是输出上限，不是每轮必须预留的消费。
      const maxOutputTokens = Math.min(
        profile.generation.max_output_tokens,
        task.budget.total_tokens - tokens.total_tokens - estimate,
      );
      if (maxOutputTokens < 1)
        throw new Stop("budget_exhausted", "token_preflight");
      if (maxOutputTokens < profile.generation.max_output_tokens) {
        body = client.requestBody(
          messages,
          toolSet,
          undefined,
          maxOutputTokens,
        );
        estimate = Buffer.byteLength(body);
        if (estimate > task.budget.max_request_bytes)
          throw new Stop("budget_exhausted", "request_size_limit");
        if (
          tokens.total_tokens + estimate + maxOutputTokens >
          task.budget.total_tokens
        )
          throw new Stop("budget_exhausted", "token_preflight");
      }
      const attemptId = randomUUID();
      await recorder.modelEvent("agent_budget", {
        ...identity,
        remaining: agent.remaining,
        input_estimate: estimate,
        estimate_method: "utf8_bytes_estimate",
        max_output_tokens: maxOutputTokens,
        configured_max_output_tokens: profile.generation.max_output_tokens,
        output_limit_policy: "remaining_budget_v1",
      });
      await recorder.modelEvent(
        "model_request",
        {
          ...identity,
          attempt_id: attemptId,
          requested_model: profile.model,
          input_estimate: estimate,
          estimate_method: "utf8_bytes_estimate",
        },
        JSON.parse(body),
      );
      checkClock();
      tokens.attempts++;
      const collaboration = recorder.manifest.collaboration;
      if (collaboration && identity) {
        collaboration.roles[identity.role].tokens.attempts++;
        if (identity.subtask_id) {
          const subtask = collaboration.subtasks.find(
            (s) => s.subtask_id === identity.subtask_id,
          );
          if (!subtask) throw new Error("Missing active subtask");
          subtask.tokens.attempts++;
        }
      }
      updateRemaining();
      const started = performance.now();
      let response: ModelResponse;
      try {
        response = await client.send(
          body,
          {
            timeout_ms: Math.max(
              1,
              Math.min(task.budget.model_timeout_ms, remainingTime()),
            ),
            max_request_bytes: task.budget.max_request_bytes,
            max_response_bytes: task.budget.max_response_bytes,
          },
          signal,
        );
      } catch (error) {
        const failure =
          error instanceof ModelFailure
            ? error
            : new ModelFailure("adapter_failure", "unknown");
        settle(
          failure.usage,
          failure.accounting === "unknown",
          performance.now() - started,
        );
        await recorder.modelEvent("model_failure", {
          ...identity,
          attempt_id: attemptId,
          code: failure.code,
          accounting: failure.accounting,
          usage: failure.usage,
          elapsed_ms: performance.now() - started,
        });
        checkClock();
        if (failure.retryable && rateRetries < task.budget.rate_retries) {
          rateRetries++;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(wait);
              signal.removeEventListener("abort", done);
              resolve();
            };
            const wait = setTimeout(
              done,
              Math.min(250 * 2 ** (rateRetries - 1), remainingTime()),
            );
            signal.addEventListener("abort", done, { once: true });
          });
          continue;
        }
        throw new Stop(
          "failed",
          failure.accounting === "unknown"
            ? "accounting_incomplete"
            : failure.code,
        );
      }
      settle(
        response.usage,
        response.usage.status === "unknown",
        response.elapsed_ms,
      );
      if (collaboration && identity) {
        const roleModel = collaboration.roles[identity.role].model;
        roleModel.returned_models.push(response.model);
        roleModel.response_ids.push(response.id);
        if (response.system_fingerprint)
          roleModel.fingerprints.push(response.system_fingerprint);
      }
      model.returned_models.push(response.model);
      model.response_ids.push(response.id);
      if (response.system_fingerprint)
        model.fingerprints.push(response.system_fingerprint);
      await recorder.modelEvent(
        "model_response",
        {
          ...identity,
          attempt_id: attemptId,
          response_id: response.id,
          returned_model: response.model,
          usage: response.usage,
          elapsed_ms: response.elapsed_ms,
        },
        response,
      );
      checkClock();
      if (tokens.status === "unknown")
        throw new Stop("failed", "accounting_incomplete");
      if (tokens.total_tokens >= task.budget.total_tokens) {
        await recorder.modelEvent("agent_budget", {
          ...identity,
          overage_tokens: Math.max(
            0,
            tokens.total_tokens - task.budget.total_tokens,
          ),
          remaining: agent.remaining,
        });
        throw new Stop("budget_exhausted", "token_threshold");
      }
      if (
        response.finish_reason === "length" ||
        response.finish_reason === "content_filter"
      )
        throw new Stop("failed", `response_${response.finish_reason}`);
      return { attemptId, response };
    }
  };
}
