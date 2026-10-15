import * as z from "zod";
import { DEFAULT_BUDGET } from "../agent/config";
import { modelCaller } from "../agent/model-call";
import { Stop } from "../agent/stop";
import { validateUsage } from "../evaluation/contracts";
import type { Message, ModelClient } from "../models/client";
import { emptyLedger, type ModelMetadata } from "../records/agent-metadata";

const positive = z.number().int().positive();
export const modelBudgetSchema = z.strictObject({
  model_attempts: positive,
  total_tokens: positive,
  timeout_ms: positive,
  model_timeout_ms: positive.default(90000),
  rate_retries: z.number().int().nonnegative().max(5).default(2),
});

/** 复用原生调用边界及保守 token 预留；所有上游阶段共享同一个账本。 */
export function baselineModel(options: {
  client: ModelClient;
  budget: unknown;
  signal: AbortSignal;
  event: (type: string, details: Record<string, unknown>) => Promise<void>;
  remainingTime?: () => number;
}) {
  const budget = modelBudgetSchema.parse(options.budget),
    started = performance.now();
  const tokens = emptyLedger(),
    agent = {
      remaining: {
        model_attempts: budget.model_attempts,
        executions: 0,
        tokens: budget.total_tokens,
        task_ms: budget.timeout_ms,
      },
    };
  const metadata: ModelMetadata = {
    profile: options.client.profile,
    returned_models: [],
    response_ids: [],
    fingerprints: [],
  };
  const remainingTime = () =>
    Math.max(
      0,
      Math.min(
        budget.timeout_ms - (performance.now() - started),
        options.remainingTime?.() ?? Infinity,
      ),
    );
  let stage = "default",
    busy = false,
    closed = false;
  const checkClock = () => {
    if (options.signal.aborted) throw new Stop("cancelled", "user_cancelled");
    if (closed) throw new Stop("failed", "model_phase_closed");
    if (remainingTime() <= 0) throw new Stop("timed_out", "task_deadline");
    // 包括 retryable=true 的未知计费故障；下一次调用前必须停止。
    if (tokens.status === "unknown")
      throw new Stop("failed", "accounting_incomplete");
  };
  const updateRemaining = () => {
    agent.remaining = {
      model_attempts: Math.max(0, budget.model_attempts - tokens.attempts),
      executions: 0,
      tokens: Math.max(0, budget.total_tokens - tokens.total_tokens),
      task_ms: remainingTime(),
    };
  };
  const call = modelCaller({
    task: {
      budget: {
        ...DEFAULT_BUDGET,
        ...budget,
        task_timeout_ms: budget.timeout_ms,
      },
    },
    client: options.client,
    profile: options.client.profile,
    tokens,
    agent,
    signal: options.signal,
    checkClock,
    remainingTime,
    updateRemaining,
    recorder: {
      manifest: {},
      modelEvent: (type, fields, content) =>
        options.event(type, {
          stage,
          ...fields,
          ...(content === undefined ? {} : { content }),
        }),
    },
    settle: (usage, unknown, elapsed) => {
      tokens.elapsed_ms += elapsed;
      tokens.input_tokens += usage.input_tokens ?? 0;
      tokens.output_tokens += usage.output_tokens ?? 0;
      tokens.total_tokens = tokens.input_tokens + tokens.output_tokens;
      if (unknown) {
        tokens.status = "unknown";
        tokens.unknown_attempts++;
      }
      updateRemaining();
    },
  });
  return {
    metadata,
    usage: () =>
      validateUsage({
        source: tokens.status === "unknown" ? "unknown" : "measured",
        attempts: tokens.attempts,
        input_tokens: tokens.input_tokens,
        output_tokens: tokens.output_tokens,
        total_tokens: tokens.total_tokens,
        unknown_attempts: tokens.unknown_attempts,
        currency_cost: "not_computed",
      }),
    close: () => {
      closed = true;
    },
    async request(
      messages: Message[],
      requestStage: string,
      tools: readonly unknown[] = [],
    ) {
      if (busy) throw new Error("Concurrent baseline model request rejected");
      busy = true;
      stage = requestStage;
      try {
        return (await call(messages, tools, metadata)).response;
      } finally {
        busy = false;
      }
    },
  };
}
