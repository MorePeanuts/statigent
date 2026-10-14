import * as z from "zod";
import { Stop } from "../agent/stop";
import type { Usage } from "../models/client";
import { integer, keys, obj } from "../models/validation";
import { emptyLedger, type TokenLedger } from "../records/agent-metadata";
import type { ModelingBudget } from "./config";
export interface RequestedBudget {
  task_timeout_ms: number;
  total_tokens: number;
  executions: number;
}
export type EffectiveBudget = RequestedBudget & { model_attempts: number };
export interface Allocation {
  requested: RequestedBudget;
  effective: EffectiveBudget;
  remaining: EffectiveBudget & { eda_calls: number; parent_task_ms: number };
  limits: EffectiveBudget & { final_reserve_ms: number };
  clipped: {
    dimension: keyof EffectiveBudget;
    constraint: "configured" | "remaining";
    limit: number;
  }[];
}
export type HostAllocation = Omit<Allocation, "requested"> & {
  version: 2;
  policy: "host-cap-v1";
};
const positiveInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 1);
const requestedBudgetSchema = z.strictObject({
  task_timeout_ms: positiveInteger,
  total_tokens: positiveInteger,
  executions: positiveInteger,
});
export function validateHostAllocation(value: unknown): HostAllocation {
  const x = obj(value);
  keys(x, ["version", "policy", "effective", "remaining", "limits", "clipped"]);
  if (x.version !== 2 || x.policy !== "host-cap-v1")
    throw new Error("Invalid host allocation version");
  const limits = obj(x.limits);
  const { requested: _requested, ...validated } = validateAllocation({
    effective: x.effective,
    remaining: x.remaining,
    limits,
    clipped: x.clipped,
    requested: {
      task_timeout_ms: limits.task_timeout_ms,
      total_tokens: limits.total_tokens,
      executions: limits.executions,
    },
  });
  return { version: 2, policy: "host-cap-v1", ...validated };
}
export function requestedBudget(value: unknown): RequestedBudget {
  const result = requestedBudgetSchema.safeParse(value);
  if (!result.success) {
    const unknown = result.error.issues.find(
      (issue) => issue.code === "unrecognized_keys",
    );
    if (unknown?.code === "unrecognized_keys")
      throw new Error(`Unsupported field: ${unknown.keys[0]}`);
    throw result.error;
  }
  return result.data;
}
export function validateAllocation(value: unknown): Allocation {
  const x = obj(value);
  keys(x, ["requested", "effective", "remaining", "limits", "clipped"]);
  const requested = requestedBudget(x.requested),
    effective = obj(x.effective),
    remaining = obj(x.remaining),
    limits = obj(x.limits);
  const dimensions = [
    "model_attempts",
    "total_tokens",
    "executions",
    "task_timeout_ms",
  ] as const;
  keys(effective, [...dimensions]);
  keys(remaining, [...dimensions, "eda_calls", "parent_task_ms"]);
  keys(limits, [...dimensions, "final_reserve_ms"]);
  integer(remaining.eda_calls, "remaining EDA calls");
  const parentMs = integer(remaining.parent_task_ms, "remaining parent time"),
    reserve = integer(limits.final_reserve_ms, "final reserve");
  const wanted = {
    ...requested,
    model_attempts: integer(limits.model_attempts, "configured model attempts"),
  };
  const clipped: Allocation["clipped"] = [];
  for (const dimension of dimensions) {
    const configured = integer(limits[dimension], `configured ${dimension}`),
      available = integer(remaining[dimension], `remaining ${dimension}`),
      actual = integer(effective[dimension], `effective ${dimension}`);
    if (actual !== Math.min(wanted[dimension], configured, available))
      throw new Error("Invalid EDA allocation");
    for (const [constraint, limit] of [
      ["configured", configured],
      ["remaining", available],
    ] as const)
      if (wanted[dimension] > limit)
        clipped.push({ dimension, constraint, limit });
  }
  if (
    remaining.task_timeout_ms !== Math.max(0, parentMs - reserve) ||
    !Array.isArray(x.clipped)
  )
    throw new Error("Invalid EDA allocation reserve");
  const actualClips = x.clipped.map((entry) => {
    const c = obj(entry);
    keys(c, ["dimension", "constraint", "limit"]);
    return {
      dimension: c.dimension,
      constraint: c.constraint,
      limit: integer(c.limit, "clipping limit"),
    };
  });
  if (JSON.stringify(actualClips) !== JSON.stringify(clipped))
    throw new Error("Invalid EDA clipping constraints");
  const parseEffective = (entry: Record<string, unknown>): EffectiveBudget => ({
    model_attempts: integer(entry.model_attempts, "model attempts"),
    total_tokens: integer(entry.total_tokens, "total tokens"),
    executions: integer(entry.executions, "executions"),
    task_timeout_ms: integer(entry.task_timeout_ms, "task timeout"),
  });
  return {
    requested,
    effective: parseEffective(effective),
    remaining: {
      ...parseEffective(remaining),
      eda_calls: integer(remaining.eda_calls, "remaining EDA calls"),
      parent_task_ms: parentMs,
    },
    limits: { ...parseEffective(limits), final_reserve_ms: reserve },
    clipped,
  };
}
export function roleLedgers(total: unknown, roles: unknown) {
  const t = ledger(total),
    r = obj(roles);
  keys(r, ["planner", "executor"]);
  const planner = ledger(r.planner),
    executor = ledger(r.executor);
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "attempts",
    "unknown_attempts",
    "elapsed_ms",
  ] as const) {
    const sum = planner[key] + executor[key];
    if (Math.abs(t[key] - sum) > (key === "elapsed_ms" ? 1e-6 : 0))
      throw new Error(`EDA role accounting mismatch: ${key}`);
  }
  if (
    t.status !==
    (planner.status === "unknown" || executor.status === "unknown"
      ? "unknown"
      : "known")
  )
    throw new Error("EDA role accounting mismatch: status");
  return { planner, executor };
}
export function ledger(value: unknown): TokenLedger {
  const x = obj(value);
  if (x.status !== "known" && x.status !== "unknown")
    throw new Error("Invalid accounting status");
  const result = emptyLedger();
  result.status = x.status;
  for (const k of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "attempts",
    "unknown_attempts",
  ] as const)
    result[k] = integer(x[k], k, 0);
  if (
    typeof x.elapsed_ms !== "number" ||
    !Number.isFinite(x.elapsed_ms) ||
    x.elapsed_ms < 0 ||
    result.total_tokens !== result.input_tokens + result.output_tokens ||
    result.unknown_attempts > result.attempts ||
    (result.status === "known" && result.unknown_attempts > 0)
  )
    throw new Error("Invalid ledger");
  result.elapsed_ms = x.elapsed_ms;
  return result;
}
export class Budget {
  readonly total = emptyLedger();
  readonly modeling = emptyLedger();
  readonly children = new Map<string, TokenLedger>();
  private readonly settlements = new Map<string, string>();
  training = 0;
  finalTraining = 0;
  confirmationTraining = 0;
  private readonly confirmationIds = new Set<string>();
  edaCalls = 0;
  edaExecutions = 0;
  constructor(
    readonly config: ModelingBudget,
    readonly remaining: () => number,
    readonly confirmationReserve = 0,
  ) {}
  settleModel(usage: Usage, unknown: boolean, elapsed: number) {
    for (const l of [this.total, this.modeling]) {
      l.input_tokens += usage.input_tokens ?? 0;
      l.output_tokens += usage.output_tokens ?? 0;
      l.total_tokens = l.input_tokens + l.output_tokens;
      l.elapsed_ms += elapsed;
      if (unknown) {
        l.status = "unknown";
        l.unknown_attempts++;
      }
    }
  }
  settleChild(id: string, value: unknown, executions: number, roles?: unknown) {
    const l = ledger(value);
    integer(executions, "EDA executions", 0);
    const settlement = JSON.stringify({
      ledger: l,
      executions,
      roles: roles === undefined ? null : roleLedgers(l, roles),
    });
    if (this.children.has(id)) {
      if (this.settlements.get(id) !== settlement)
        throw new Error("Conflicting settlement");
      return;
    }
    this.settlements.set(id, settlement);
    this.children.set(id, l);
    this.edaExecutions += executions;
    for (const k of [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "attempts",
      "unknown_attempts",
      "elapsed_ms",
    ] as const)
      this.total[k] += l[k];
    if (l.status === "unknown") this.total.status = "unknown";
    this.checkExecution();
  }
  checkExecution() {
    if (this.remaining() <= 0) throw new Stop("timed_out", "task_deadline");
  }
  check() {
    if (this.total.status === "unknown")
      throw new Stop("failed", "accounting_incomplete");
    if (this.remaining() <= 0) throw new Stop("timed_out", "task_deadline");
    if (this.total.total_tokens >= this.config.total_tokens)
      throw new Stop("budget_exhausted", "token_threshold");
  }
  explorationMs() {
    return Math.max(0, this.remaining() - this.config.final_reserve_ms);
  }
  canTrain(final: boolean) {
    if (final) this.checkExecution();
    else this.check();
    const cap =
      (this.config.training_attempts ?? Number.POSITIVE_INFINITY) -
      (final
        ? 0
        : this.config.final_training_attempts + this.confirmationReserve);
    if (
      this.training >= cap ||
      (!final && this.explorationMs() <= 0) ||
      (final && this.finalTraining >= this.config.final_training_attempts)
    )
      throw new Error("Training budget reserved or exhausted");
  }
  train(final: boolean) {
    this.canTrain(final);
    this.training++;
    if (final) this.finalTraining++;
  }
  confirmationMs() {
    return Math.max(
      0,
      this.remaining() -
        this.config.final_training_attempts *
          (this.config.fit_timeout_ms + this.config.predict_timeout_ms),
    );
  }
  confirm(id: string) {
    this.checkExecution();
    if (this.confirmationIds.has(id))
      throw new Error("Confirmation already charged");
    if (
      this.confirmationTraining >= this.confirmationReserve ||
      this.training >=
        (this.config.training_attempts ?? Number.POSITIVE_INFINITY) -
          this.config.final_training_attempts ||
      this.confirmationMs() <= 0
    )
      throw new Error("Confirmation budget exhausted");
    this.confirmationIds.add(id);
    this.confirmationTraining++;
    this.training++;
  }
  childBudget(request: RequestedBudget): Allocation {
    const requested = requestedBudget(request);
    this.check();
    if (this.edaCalls >= this.config.eda_calls)
      throw new Error("EDA call budget exhausted");
    const parentTaskMs = Math.floor(this.remaining());
    const remaining = {
      parent_task_ms: parentTaskMs,
      eda_calls: this.config.eda_calls - this.edaCalls,
      model_attempts: this.config.model_attempts - this.total.attempts,
      total_tokens: this.config.total_tokens - this.total.total_tokens,
      executions: this.config.eda_executions - this.edaExecutions,
      task_timeout_ms: Math.max(0, parentTaskMs - this.config.final_reserve_ms),
    };
    const limits = {
      model_attempts: this.config.eda_model_attempts,
      total_tokens: this.config.eda_tokens,
      executions: this.config.eda_executions,
      task_timeout_ms: this.config.eda_timeout_ms,
      final_reserve_ms: this.config.final_reserve_ms,
    };
    const desired = { ...requested, model_attempts: limits.model_attempts };
    const effective = { ...desired };
    const clipped: Allocation["clipped"] = [];
    for (const dimension of [
      "model_attempts",
      "total_tokens",
      "executions",
      "task_timeout_ms",
    ] as const) {
      effective[dimension] = Math.min(
        desired[dimension],
        limits[dimension],
        remaining[dimension],
      );
      for (const [constraint, bound] of [
        ["configured", limits],
        ["remaining", remaining],
      ] as const)
        if (desired[dimension] > bound[dimension])
          clipped.push({ dimension, constraint, limit: bound[dimension] });
      if (effective[dimension] <= 0)
        throw new Error(
          `EDA budget reserved or exhausted: ${dimension}; remaining=${JSON.stringify(remaining)}`,
        );
    }
    return { requested, effective, remaining, limits, clipped };
  }
  hostChildBudget(): HostAllocation {
    const { requested: _requested, ...allocation } = this.childBudget({
      task_timeout_ms: this.config.eda_timeout_ms,
      total_tokens: this.config.eda_tokens,
      executions: this.config.eda_executions,
    });
    return validateHostAllocation({
      version: 2,
      policy: "host-cap-v1",
      ...allocation,
    });
  }
  snapshot() {
    return {
      tokens: this.total,
      modeling: this.modeling,
      children: Object.fromEntries(this.children),
      training_attempts: this.training,
      final_training_attempts: this.finalTraining,
      confirmation_training_attempts: this.confirmationTraining,
      eda_calls: this.edaCalls,
      eda_executions: this.edaExecutions,
      remaining_ms: this.remaining(),
      exploration_ms: this.explorationMs(),
    };
  }
}
