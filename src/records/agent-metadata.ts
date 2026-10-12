import type { AgentBudget } from "../agent/config";
import type { ModelProfile } from "../models/config";
import { validateProfile } from "../models/config";
import { integer, obj, str } from "../models/validation";
export interface TokenLedger {
  status: "known" | "unknown";
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  attempts: number;
  unknown_attempts: number;
  elapsed_ms: number;
  currency_cost: "not_computed";
}
export interface ModelMetadata {
  profile: ModelProfile;
  returned_models: string[];
  response_ids: string[];
  fingerprints: string[];
}
export interface PromptMetadata {
  version: string;
  sha256: string;
}
export interface AgentMetadata {
  goal: string;
  constraints: string[];
  budget: AgentBudget;
  remaining: {
    model_attempts: number;
    executions: number;
    tokens: number;
    task_ms: number;
  };
  executions: number;
  termination: string | null;
  final_result: string | null;
  trace_bytes: number;
  trace_incomplete: boolean;
}
export function validateAgentFields(value: Record<string, unknown>): void {
  if (value.schema_version === 1) {
    if (
      [value.model, value.prompt, value.tokens].some(
        (v) => v !== "not_applicable",
      )
    )
      throw new Error("Invalid legacy model metadata");
    return;
  }
  if (!["runtime", "agent", "code_replay"].includes(String(value.run_kind)))
    throw new Error("Invalid run_kind");
  if (value.run_kind !== "agent") {
    if (
      [value.model, value.prompt, value.tokens, value.agent].some(
        (v) => v !== "not_applicable",
      )
    )
      throw new Error("Model metadata in non-agent run");
    return;
  }
  const model = obj(value.model);
  validateProfile(model.profile);
  for (const key of ["returned_models", "response_ids", "fingerprints"]) {
    const a = model[key];
    if (!Array.isArray(a) || !a.every((x) => typeof x === "string"))
      throw new Error(`Invalid ${key}`);
  }
  const prompt = obj(value.prompt);
  str(prompt.version, "prompt version");
  if (
    typeof prompt.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(prompt.sha256)
  )
    throw new Error("Invalid prompt hash");
  const tokens = obj(value.tokens);
  if (
    !["known", "unknown"].includes(String(tokens.status)) ||
    tokens.currency_cost !== "not_computed"
  )
    throw new Error("Invalid token status");
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "attempts",
    "unknown_attempts",
  ])
    integer(tokens[key], key, 0);
  if (
    tokens.total_tokens !==
      Number(tokens.input_tokens) + Number(tokens.output_tokens) ||
    (tokens.status === "known") !== (tokens.unknown_attempts === 0) ||
    Number(tokens.unknown_attempts) > Number(tokens.attempts)
  )
    throw new Error("Inconsistent token ledger");
  if (
    typeof tokens.elapsed_ms !== "number" ||
    !Number.isFinite(tokens.elapsed_ms) ||
    tokens.elapsed_ms < 0
  )
    throw new Error("Invalid model timing");
  const agent = obj(value.agent);
  str(agent.goal, "goal");
  if (
    !Array.isArray(agent.constraints) ||
    !agent.constraints.every((s) => typeof s === "string")
  )
    throw new Error("Invalid constraints");
  const b = obj(agent.budget);
  for (const key of [
    "model_attempts",
    "executions",
    "total_tokens",
    "model_timeout_ms",
    "task_timeout_ms",
    "max_request_bytes",
    "max_response_bytes",
    "max_trace_bytes",
    "rate_retries",
    "code_repairs",
    "action_corrections",
  ])
    integer(
      b[key],
      key,
      ["rate_retries", "code_repairs", "action_corrections"].includes(key)
        ? 0
        : 1,
    );
  const remaining = obj(agent.remaining);
  for (const key of ["model_attempts", "executions", "tokens", "task_ms"])
    integer(remaining[key], key, 0);
  integer(agent.executions, "executions", 0);
  integer(agent.trace_bytes, "trace_bytes", 0);
  if (typeof agent.trace_incomplete !== "boolean")
    throw new Error("Invalid trace completeness");
  if (agent.termination !== null) str(agent.termination, "termination");
  if (agent.final_result !== null && agent.final_result !== "analysis.json")
    throw new Error("Invalid final result path");
}
