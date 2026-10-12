import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ChatClient,
  type ContentPart,
  completeText,
  type ModelClient,
  ModelFailure,
} from "../models/client";
import type { ModelProfile } from "../models/config";
import { DEFAULT_IMAGE_LIMITS } from "../models/images";
import { sha256 } from "../records/store";
import {
  id,
  type JudgeClient,
  type JudgePart,
  type JudgeSummary,
  LIMITS,
} from "./contracts";
import type { ScoringConfig } from "./plan";

/** Judge budget is exhausted (or usage became unknown); no further judge request may be sent. */
export class JudgeBudgetExhausted extends Error {}
export class JudgeFailure extends Error {}
export interface JudgeLimits {
  request_timeout_ms: number;
  max_request_bytes: number;
  max_response_bytes: number;
  rate_retries: number;
  backoff_ms: number;
  recorded_response_bytes: number;
}
export const DEFAULT_JUDGE_LIMITS: JudgeLimits = {
  request_timeout_ms: 300000,
  max_request_bytes: 32 * 1024 * 1024,
  max_response_bytes: 2 * 1024 * 1024,
  rate_retries: 2,
  backoff_ms: 1000,
  recorded_response_bytes: 65536,
};
interface Ledger {
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  unknown_attempts: number;
  elapsed_ms: number;
}
const emptyLedger = (): Ledger => ({
  attempts: 0,
  input_tokens: 0,
  output_tokens: 0,
  unknown_attempts: 0,
  elapsed_ms: 0,
});
/**
 * One scoring pass (batch or rescore). Holds the batch judge budget and writes every attempt to
 * `<directory>/<unit_id>.jsonl` on the scoring side only.
 */
export class JudgeSession {
  readonly batch = emptyLedger();
  private readonly began = Date.now();
  private readonly clients = new Map<string, ModelClient>();
  exhausted = "";
  constructor(
    readonly scoring: ScoringConfig,
    readonly directory: string,
    private readonly agentModels: string[],
    private readonly factory: (profile: ModelProfile) => ModelClient = (p) =>
      new ChatClient(p),
    private readonly limits: JudgeLimits = DEFAULT_JUDGE_LIMITS,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}
  /** Checks credentials for every mapped role without sending anything. */
  preflight(): void {
    for (const profile of Object.values(this.scoring.judges))
      this.client(profile);
  }
  private client(profile: ModelProfile): ModelClient {
    let c = this.clients.get(profile.id);
    if (!c) {
      c = this.factory(profile);
      this.clients.set(profile.id, c);
    }
    return c;
  }
  private remaining(
    ledger: Ledger,
    budget: ScoringConfig["unit_budget"],
    began: number,
  ) {
    return {
      attempts: budget.model_attempts - ledger.attempts,
      tokens:
        budget.total_tokens - (ledger.input_tokens + ledger.output_tokens),
      ms: budget.timeout_ms - (Date.now() - began),
    };
  }
  forUnit(unitId: string, signal?: AbortSignal): UnitJudge {
    return new UnitJudge(this, id(unitId), signal);
  }
  /** Internal: dispatches one request after both budgets allow it. */
  async attempt(
    unit: UnitJudge,
    role: string,
    parts: JudgePart[],
    label: string,
    attempt: number,
  ): Promise<{ text: string } | { failure: ModelFailure }> {
    if (this.exhausted) throw new JudgeBudgetExhausted(this.exhausted);
    const profile = this.scoring.judges[role];
    if (!profile) throw new JudgeFailure(`Undeclared judge role: ${role}`);
    const b = this.remaining(this.batch, this.scoring.batch_budget, this.began);
    const u = this.remaining(unit.ledger, this.scoring.unit_budget, unit.began);
    if (b.attempts <= 0 || b.tokens <= 0 || b.ms <= 0) {
      this.exhausted = "judge_budget_exhausted";
      throw new JudgeBudgetExhausted(this.exhausted);
    }
    if (u.attempts <= 0 || u.tokens <= 0 || u.ms <= 0)
      throw new JudgeBudgetExhausted("judge_unit_budget_exhausted");
    const content: ContentPart[] = [];
    const images: { path: string; sha256: string; bytes: number }[] = [];
    for (const p of parts) {
      if (p.type === "text") {
        content.push({ type: "text", text: p.text });
        continue;
      }
      if ((await stat(p.path)).size > DEFAULT_IMAGE_LIMITS.max_image_bytes)
        throw new JudgeFailure(`Judge image too large: ${p.path}`);
      const data = await Bun.file(p.path).bytes();
      content.push({ type: "image", data });
      images.push({
        path: p.path.split("/").slice(-2).join("/"),
        sha256: sha256(data),
        bytes: data.byteLength,
      });
    }
    const timeout = Math.max(
      1,
      Math.min(this.limits.request_timeout_ms, b.ms, u.ms),
    );
    const started = Date.now();
    const controller = new AbortController();
    const combined = unit.signal
      ? AbortSignal.any([unit.signal, controller.signal])
      : controller.signal;
    let outcome: { text: string } | { failure: ModelFailure };
    let response: Awaited<ReturnType<typeof completeText>> | null = null;
    try {
      response = await completeText(
        this.client(profile),
        [{ role: "user", content }],
        {
          timeout_ms: timeout,
          max_request_bytes: this.limits.max_request_bytes,
          max_response_bytes: this.limits.max_response_bytes,
          images: DEFAULT_IMAGE_LIMITS,
        },
        combined,
      );
      outcome = { text: response.text };
    } catch (error) {
      outcome = {
        failure:
          error instanceof ModelFailure
            ? error
            : new ModelFailure("judge_transport_failure", "unknown"),
      };
    }
    const elapsed = Date.now() - started;
    const usage =
      "failure" in outcome ? outcome.failure.usage : response?.usage;
    const accounting =
      "failure" in outcome
        ? outcome.failure.accounting
        : usage?.status === "known"
          ? "known"
          : "unknown";
    for (const ledger of [this.batch, unit.ledger]) {
      // Requests rejected before generation cost nothing; everything else counts as an attempt.
      if (accounting !== "not_generated") ledger.attempts++;
      if (accounting === "unknown") ledger.unknown_attempts++;
      ledger.input_tokens += usage?.input_tokens ?? 0;
      ledger.output_tokens += usage?.output_tokens ?? 0;
      ledger.elapsed_ms += elapsed;
    }
    if (response) {
      unit.models.add(response.model);
      if (response.system_fingerprint)
        unit.fingerprints.add(response.system_fingerprint);
    }
    const text = "failure" in outcome ? "" : outcome.text;
    await unit.record({
      at: new Date().toISOString(),
      role,
      profile: profile.id,
      requested_model: profile.model,
      label,
      attempt,
      // Rubrics, reference reports and answers stay out of logs: only their hashes are kept.
      request: {
        text_sha256: sha256(
          Buffer.from(
            parts.map((p) => (p.type === "text" ? p.text : "")).join("\0"),
          ),
        ),
        images,
      },
      outcome: "failure" in outcome ? outcome.failure.code : "response",
      accounting,
      usage: usage ?? null,
      model: response?.model ?? null,
      system_fingerprint: response?.system_fingerprint ?? null,
      response: text.slice(0, this.limits.recorded_response_bytes),
      response_truncated: text.length > this.limits.recorded_response_bytes,
      elapsed_ms: elapsed,
    });
    if (accounting === "unknown") {
      // Without settled usage the token budget cannot be enforced any more.
      this.exhausted = "unknown_judge_usage";
    }
    return outcome;
  }
  async backoff(ms: number): Promise<void> {
    await this.sleep(ms);
  }
  get backoffMs(): number {
    return this.limits.backoff_ms;
  }
  get rateRetries(): number {
    return this.limits.rate_retries;
  }
  modelOverlap(): boolean {
    return Object.values(this.scoring.judges).some((p) =>
      this.agentModels.includes(p.model),
    );
  }
}
export class UnitJudge implements JudgeClient {
  readonly ledger = emptyLedger();
  readonly began = Date.now();
  readonly models = new Set<string>();
  readonly fingerprints = new Set<string>();
  private log = 0;
  constructor(
    private readonly session: JudgeSession,
    readonly unitId: string,
    readonly signal?: AbortSignal,
  ) {}
  async record(entry: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ unit_id: this.unitId, ...entry })}\n`;
    this.log += Buffer.byteLength(line);
    if (this.log > LIMITS.events) throw new JudgeFailure("Judge log quota");
    await mkdir(this.session.directory, { recursive: true });
    const file = await open(
      join(this.session.directory, `${this.unitId}.jsonl`),
      "a",
      0o600,
    );
    try {
      await file.writeFile(line);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async ask<T>(
    role: string,
    parts: JudgePart[],
    label: string,
    parse: (reply: string) => Promise<T> | T,
  ): Promise<T> {
    const retries = this.session.scoring.parse_retries;
    let rate = 0;
    for (let attempt = 0, parsed = 0; parsed <= retries; attempt++) {
      this.signal?.throwIfAborted();
      const outcome = await this.session.attempt(
        this,
        role,
        parts,
        label,
        attempt,
      );
      if ("failure" in outcome) {
        const f = outcome.failure;
        if (f.retryable && rate < this.session.rateRetries) {
          await this.session.backoff(this.session.backoffMs * 2 ** rate++);
          continue;
        }
        throw new JudgeFailure(`Judge request failed (${label}): ${f.code}`);
      }
      try {
        return await parse(outcome.text);
      } catch (error) {
        parsed++;
        await this.record({
          at: new Date().toISOString(),
          role,
          label,
          attempt,
          outcome: "parse_error",
          error: error instanceof Error ? error.message.slice(0, 1024) : "",
        });
      }
    }
    throw new JudgeFailure(`Judge output unparseable after retries (${label})`);
  }
  summary(): JudgeSummary {
    const l = this.ledger;
    return {
      roles: Object.fromEntries(
        Object.entries(this.session.scoring.judges).map(([r, p]) => [r, p.id]),
      ),
      attempts: l.attempts,
      input_tokens: l.input_tokens,
      output_tokens: l.output_tokens,
      total_tokens: l.input_tokens + l.output_tokens,
      unknown_attempts: l.unknown_attempts,
      elapsed_ms: l.elapsed_ms,
      models: [...this.models].sort(),
      fingerprints: [...this.fingerprints].sort(),
      self_preference_risk: this.session.modelOverlap(),
    };
  }
}
