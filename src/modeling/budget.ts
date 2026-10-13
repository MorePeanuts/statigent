import { Stop } from "../agent/stop";
import type { Usage } from "../models/client";
import { integer, obj } from "../models/validation";
import { emptyLedger, type TokenLedger } from "../records/agent-metadata";
import type { ModelingBudget } from "./config";
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
  training = 0;
  finalTraining = 0;
  edaCalls = 0;
  edaExecutions = 0;
  constructor(
    readonly config: ModelingBudget,
    readonly remaining: () => number,
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
  settleChild(id: string, value: unknown, executions: number) {
    const l = ledger(value);
    integer(executions, "EDA executions", 0);
    if (this.children.has(id)) {
      if (JSON.stringify(this.children.get(id)) !== JSON.stringify(l))
        throw new Error("Conflicting settlement");
      return;
    }
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
    this.check();
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
  train(final: boolean) {
    this.check();
    const cap =
      this.config.training_attempts -
      (final ? 0 : this.config.final_training_attempts);
    if (
      this.training >= cap ||
      (!final && this.explorationMs() <= 0) ||
      (final && this.finalTraining >= this.config.final_training_attempts)
    )
      throw new Error("Training budget reserved or exhausted");
    this.training++;
    if (final) this.finalTraining++;
  }
  childBudget() {
    this.check();
    if (this.edaCalls >= this.config.eda_calls)
      throw new Error("EDA call budget exhausted");
    const b = {
      model_attempts: Math.min(
        this.config.eda_model_attempts,
        this.config.model_attempts - this.total.attempts,
      ),
      total_tokens: Math.min(
        this.config.eda_tokens,
        this.config.total_tokens - this.total.total_tokens,
      ),
      executions: this.config.eda_executions - this.edaExecutions,
      task_timeout_ms: Math.min(
        this.config.eda_timeout_ms,
        this.explorationMs(),
      ),
    };
    if (Object.values(b).some((x) => x <= 0))
      throw new Error("EDA budget reserved or exhausted");
    return b;
  }
  snapshot() {
    return {
      tokens: this.total,
      modeling: this.modeling,
      children: Object.fromEntries(this.children),
      training_attempts: this.training,
      final_training_attempts: this.finalTraining,
      eda_calls: this.edaCalls,
      eda_executions: this.edaExecutions,
      remaining_ms: this.remaining(),
      exploration_ms: this.explorationMs(),
    };
  }
}
