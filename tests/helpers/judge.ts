import type { BenchmarkAdapter } from "../../src/evaluation/contracts";
import {
  type Message,
  type ModelClient,
  ModelFailure,
  type ModelResponse,
  normalizeUsage,
  type RequestLimits,
  serializeMessages,
} from "../../src/models/client";
import { type ModelProfile, validateProfile } from "../../src/models/config";
import { fixtureRegistry } from "./evaluation";
import { png } from "./images";

export const judgeProfile: ModelProfile = validateProfile({
  id: "judge",
  provider: "generic",
  protocol: "chat-completions",
  base_url: "https://judge.invalid",
  model: "judge-model",
  display_name: "Judge",
  api_key_env: "JUDGE_TEST_KEY",
  capabilities: { tool_calls: true, thinking: false, vision: true },
  generation: { max_output_tokens: 100, temperature: 0 },
});
export const textJudge = validateProfile({
  ...judgeProfile,
  id: "text-judge",
  capabilities: { tool_calls: true, thinking: false },
});
export type Outcome = string | ModelFailure;
/** Scripted judge: returns queued replies (or throws queued failures) and records request bodies. */
export class FakeJudge implements ModelClient {
  readonly bodies: Record<string, unknown>[] = [];
  constructor(
    readonly profile: ModelProfile,
    private readonly next: (
      body: Record<string, unknown>,
      n: number,
    ) => Outcome,
  ) {}
  requestBody(messages: Message[], tools: readonly unknown[]): string {
    return JSON.stringify({
      model: this.profile.model,
      messages: serializeMessages(this.profile, messages),
      ...(tools.length ? { tools } : {}),
    });
  }
  async send(
    body: string,
    _limits: RequestLimits,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    signal.throwIfAborted();
    const parsed = JSON.parse(body) as Record<string, unknown>;
    this.bodies.push(parsed);
    const outcome = this.next(parsed, this.bodies.length - 1);
    if (outcome instanceof ModelFailure) throw outcome;
    return {
      id: `r${this.bodies.length}`,
      model: "judge-model-2026",
      system_fingerprint: "fp",
      message: { role: "assistant", content: outcome },
      finish_reason: "stop",
      usage: normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 }),
      elapsed_ms: 1,
    };
  }
}
/**
 * Synthetic judged protocol: one text verdict and, when the unit delivered `chart.png`, one vision
 * verdict. Replies must be `score:<0..1>`; anything else is a parse error.
 */
export function judgedRegistry(root: string) {
  const registry = fixtureRegistry(root, async (i) => {
    const { submission } = await import("./evaluation");
    if (i.unit_id !== "unit-000002")
      await Bun.write(`${i.deliverables_root}/chart.png`, png(2, 2));
    return submission(i.unit_id);
  });
  const base = registry.getBenchmark("synthetic");
  const parse = (reply: string) => {
    const match = /^score:(0(\.\d+)?|1(\.0+)?)$/.exec(reply.trim());
    if (!match) throw new Error("unparseable");
    return Number(match[1]);
  };
  const judged: BenchmarkAdapter = {
    ...base,
    id: "judged",
    protocol: "judged-v1",
    summaries: [
      { name: "group_score", metric: "score", within: "mean", across: "mean" },
    ],
    catalog: async (o) => ({
      ...(await base.catalog(o)),
      groups: { one: "g1", two: "g2" },
    }),
    judgeRoles: () => [
      { id: "text", needs: ["text"] },
      { id: "vision", needs: ["vision"] },
    ],
    async score(_o, _t, s, context) {
      if (!context.judge) throw new Error("judge required");
      const text = await context.judge.ask(
        "text",
        [{ type: "text", text: `rubric-secret ${s.answer_text}` }],
        "text",
        parse,
      );
      const chart = s.deliverables.find((d) => d.path === "chart.png");
      const vision = chart
        ? await context.judge.ask(
            "vision",
            [
              { type: "text", text: "compare" },
              { type: "image", path: `${context.deliverables_root}/chart.png` },
            ],
            "vision",
            parse,
          )
        : 0;
      return {
        schema_version: 2,
        unit_id: s.unit_id,
        protocol: "judged-v1",
        status: "scored",
        metrics: [
          {
            name: "score",
            value: (text + vision) / 2,
            minimum: 0,
            maximum: 1,
            direction: "higher",
          },
        ],
        details: {},
        error: null,
        judge: null,
      };
    },
  };
  registry.benchmark(judged);
  return registry;
}
export function judgedConfig(scoring: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    purpose: "development",
    development_overlap: "synthetic only",
    benchmark: {
      adapter: "judged",
      version: "v1",
      options: {},
      task_ids: ["one", "two"],
    },
    agents: [{ id: "a", adapter: "fixture", options: {}, require_seed: true }],
    repetitions: 1,
    seed: 42,
    task_budget: { timeout_ms: 1000, model_attempts: null, total_tokens: null },
    batch_budget: {
      timeout_ms: 10000,
      model_attempts: null,
      total_tokens: null,
    },
    scoring: {
      judges: { text: judgeProfile, vision: judgeProfile },
      unit_budget: {
        timeout_ms: 10000,
        model_attempts: 10,
        total_tokens: 1000,
      },
      batch_budget: {
        timeout_ms: 10000,
        model_attempts: 100,
        total_tokens: 10000,
      },
      parse_retries: 1,
      ...scoring,
    },
  };
}
