import type { AgentBudget } from "../agent/config";
import type { ModelProfile } from "../models/config";
import { validateProfile } from "../models/config";
import { integer, keys, obj, str, strings } from "../models/validation";
export type AgentRole = "planner" | "executor";
export type SubtaskStatus =
  | "running"
  | "completed"
  | "partial"
  | "needs_clarification"
  | "failed";
export interface RoleRecord {
  model: ModelMetadata;
  prompt: PromptMetadata;
  tokens: TokenLedger;
}
export interface SubtaskRecord {
  subtask_id: string;
  tool_id: string;
  status: SubtaskStatus;
  tokens: TokenLedger;
  evidence_refs: string[];
}
export interface CollaborationRecord {
  organization: "planner-executor";
  roles: Record<AgentRole, RoleRecord>;
  subtasks: SubtaskRecord[];
}
export function emptyLedger(): TokenLedger {
  return {
    status: "known",
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    attempts: 0,
    unknown_attempts: 0,
    elapsed_ms: 0,
    currency_cost: "not_computed",
  };
}
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
  completion_policy?: "modeling-diagnostic-v1";
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
  if (value.schema_version === 3 && value.run_kind !== "agent")
    throw new Error("v3 requires agent run");
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
  if (
    agent.completion_policy !== undefined &&
    agent.completion_policy !== "modeling-diagnostic-v1"
  )
    throw new Error("Invalid completion policy");
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
  if (
    value.schema_version === 3 ||
    (value.schema_version === 4 && value.collaboration !== undefined)
  ) {
    const c = obj(value.collaboration);
    keys(c, ["organization", "roles", "subtasks"]);
    if (c.organization !== "planner-executor")
      throw new Error("Invalid collaboration organization");
    const roles = obj(c.roles);
    keys(roles, ["planner", "executor"]);
    const ledgers: Record<string, unknown>[] = [];
    for (const role of ["planner", "executor"]) {
      const record = obj(roles[role]);
      keys(record, ["model", "prompt", "tokens"]);
      // Reuse the legacy validation rules without interpreting role data as a second run.
      validateAgentFields({
        ...value,
        schema_version: 2,
        collaboration: undefined,
        ...record,
      });
      if (
        JSON.stringify(obj(record.model).profile) !==
        JSON.stringify(model.profile)
      )
        throw new Error("Role/profile mismatch");
      ledgers.push(obj(record.tokens));
    }
    for (const key of [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "attempts",
      "unknown_attempts",
      "elapsed_ms",
    ]) {
      const sum = ledgers.reduce((n, ledger) => n + Number(ledger[key]), 0);
      if (
        Math.abs(sum - Number(tokens[key])) >
        (key === "elapsed_ms" ? 0.000001 : 0)
      )
        throw new Error("Role totals do not match task ledger");
    }
    if (!Array.isArray(c.subtasks)) throw new Error("Invalid subtasks");
    const ids = new Set<string>(),
      tools = new Set<string>();
    let attempts = 0,
      total = 0,
      running = 0;
    for (const value of c.subtasks) {
      const subtask = obj(value);
      keys(subtask, [
        "subtask_id",
        "tool_id",
        "status",
        "tokens",
        "evidence_refs",
      ]);
      const id = str(subtask.subtask_id, "subtask_id"),
        tool = str(subtask.tool_id, "tool_id");
      if (ids.has(id) || tools.has(tool))
        throw new Error("Duplicate subtask identity");
      ids.add(id);
      tools.add(tool);
      if (
        ![
          "running",
          "completed",
          "partial",
          "needs_clarification",
          "failed",
        ].includes(String(subtask.status))
      )
        throw new Error("Invalid subtask status");
      if (subtask.status === "running") running++;
      strings(subtask.evidence_refs, "evidence_refs");
      const ledger = obj(subtask.tokens);
      validateAgentFields({
        ...obj(roles.executor),
        tokens: ledger,
        schema_version: 2,
        run_kind: "agent",
        agent,
      });
      attempts += Number(ledger.attempts);
      total += Number(ledger.total_tokens);
    }
    const executor = obj(obj(roles.executor).tokens);
    if (
      running > 1 ||
      attempts !== executor.attempts ||
      total !== executor.total_tokens
    )
      throw new Error("Subtask totals do not match executor ledger");
  } else if (value.collaboration !== undefined) {
    throw new Error("Collaboration requires manifest v3 or v4");
  }
}
