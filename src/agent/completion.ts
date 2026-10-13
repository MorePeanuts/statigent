import type { AgentMetadata, AgentRole } from "../records/agent-metadata";

export const DIAGNOSTIC_OUTPUT_TOKENS = 8192;
// Conservative request bytes match the existing token preflight. Reserve another
// executor request and the planner's final synthesis, including result growth.
export function diagnosticClosure(o: {
  role: AgentRole;
  remaining: AgentMetadata["remaining"];
  executorBytes: number;
  plannerBytes: number;
  modelTimeoutMs: number;
  maxRequestBytes: number;
}) {
  const reserveTokens =
    2 * o.executorBytes + o.plannerBytes + 6 * DIAGNOSTIC_OUTPUT_TOKENS;
  const reason =
    o.remaining.model_attempts <= (o.role === "executor" ? 2 : 3)
      ? "model_attempt_reserve"
      : o.remaining.executions === 0
        ? "execution_limit"
        : o.remaining.tokens <= reserveTokens
          ? "token_return_reserve"
          : o.executorBytes + 4 * DIAGNOSTIC_OUTPUT_TOKENS >= o.maxRequestBytes
            ? "request_growth_reserve"
            : o.remaining.task_ms <= 2 * Math.min(o.modelTimeoutMs, 30000)
              ? "time_return_reserve"
              : null;
  return { reason, reserve_tokens: reserveTokens };
}
