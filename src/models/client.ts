import {
  type ModelProfile,
  resolveCredential,
  validateProfile,
} from "./config";
import { integer, obj, str } from "./validation";
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | AssistantMessage;
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
}
export interface Usage {
  status: "known" | "unknown";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  reasoning_tokens: number | null;
  raw: Record<string, unknown> | null;
}
export interface ModelResponse {
  id: string;
  model: string;
  system_fingerprint: string | null;
  message: AssistantMessage;
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  usage: Usage;
  elapsed_ms: number;
}
export interface RequestLimits {
  timeout_ms: number;
  max_request_bytes: number;
  max_response_bytes: number;
}
export class ModelFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly accounting: "not_generated" | "known" | "unknown",
    public readonly retryable = false,
    public readonly usage: Usage = normalizeUsage(null),
  ) {
    super(code);
  }
}
export function normalizeUsage(value: unknown): Usage {
  const raw = value === null || value === undefined ? null : obj(value);
  const count = (v: unknown): number | null =>
    v === undefined || v === null ? null : integer(v, "usage count", 0);
  const input = count(raw?.prompt_tokens);
  const output = count(raw?.completion_tokens);
  const details =
    raw?.completion_tokens_details === undefined
      ? null
      : obj(raw.completion_tokens_details);
  const prompt =
    raw?.prompt_tokens_details === undefined
      ? null
      : obj(raw.prompt_tokens_details);
  const hit = count(raw?.prompt_cache_hit_tokens ?? prompt?.cached_tokens);
  const miss = count(raw?.prompt_cache_miss_tokens);
  const reasoning = count(details?.reasoning_tokens);
  if (
    (input !== null && (hit ?? 0) + (miss ?? 0) > input) ||
    (output !== null && (reasoning ?? 0) > output)
  )
    throw new Error("Invalid usage subsets");
  if (raw?.total_tokens !== undefined)
    integer(raw.total_tokens, "total_tokens", 0);
  return {
    status: input !== null && output !== null ? "known" : "unknown",
    input_tokens: input,
    output_tokens: output,
    total_tokens: input !== null && output !== null ? input + output : null,
    cache_hit_tokens: hit,
    cache_miss_tokens: miss,
    reasoning_tokens: reasoning,
    raw,
  };
}
export function parseResponse(
  value: unknown,
  profile: ModelProfile,
  elapsed: number,
): ModelResponse {
  const x = obj(value);
  const usage = normalizeUsage(x.usage);
  try {
    if (!Array.isArray(x.choices) || x.choices.length !== 1)
      throw new Error("Expected one choice");
    const choice = obj(x.choices[0]);
    if (choice.index !== 0) throw new Error("Invalid choice index");
    const reason = choice.finish_reason;
    if (
      reason !== "stop" &&
      reason !== "tool_calls" &&
      reason !== "length" &&
      reason !== "content_filter"
    )
      throw new Error("Invalid finish_reason");
    const m = obj(choice.message);
    if (
      m.role !== "assistant" ||
      (m.content !== null && typeof m.content !== "string")
    )
      throw new Error("Invalid assistant message");
    const message: AssistantMessage = { role: "assistant", content: m.content };
    if (m.reasoning_content !== undefined && m.reasoning_content !== null) {
      if (typeof m.reasoning_content !== "string")
        throw new Error("Invalid reasoning_content");
      if (profile.provider === "deepseek")
        message.reasoning_content = m.reasoning_content;
    }
    if (
      profile.provider === "deepseek" &&
      profile.generation.thinking === "enabled" &&
      message.reasoning_content === undefined
    )
      throw new Error("Missing reasoning_content");
    if (m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls) || !m.tool_calls.length)
        throw new Error("Invalid tool calls");
      const seen = new Set<string>();
      message.tool_calls = m.tool_calls.map((v) => {
        const c = obj(v);
        const f = obj(c.function);
        const id = str(c.id, "tool ID");
        if (seen.has(id) || c.type !== "function")
          throw new Error("Duplicate/invalid tool ID");
        seen.add(id);
        if (typeof f.arguments !== "string")
          throw new Error("Invalid arguments encoding");
        return {
          id,
          type: "function",
          function: { name: str(f.name, "tool name"), arguments: f.arguments },
        };
      });
    }
    if (
      (reason === "tool_calls" && !message.tool_calls) ||
      (reason === "stop" && message.tool_calls)
    )
      throw new Error("Inconsistent finish reason");
    return {
      id: str(x.id, "response ID"),
      model: str(x.model, "response model"),
      system_fingerprint:
        x.system_fingerprint === undefined || x.system_fingerprint === null
          ? null
          : str(x.system_fingerprint, "fingerprint"),
      message,
      finish_reason: reason,
      usage,
      elapsed_ms: elapsed,
    };
  } catch {
    throw new ModelFailure(
      "invalid_response_protocol",
      usage.status === "known" ? "known" : "unknown",
      false,
      usage,
    );
  }
}
export interface ModelClient {
  readonly profile: ModelProfile;
  requestBody(messages: Message[], tools: readonly unknown[]): string;
  send(
    body: string,
    limits: RequestLimits,
    signal: AbortSignal,
  ): Promise<ModelResponse>;
}
export class ChatClient implements ModelClient {
  readonly profile: ModelProfile;
  #key: string;
  constructor(
    profile: ModelProfile,
    environment: Record<string, string | undefined> = process.env,
  ) {
    this.profile = validateProfile(profile);
    this.#key = resolveCredential(this.profile, environment);
  }
  requestBody(messages: Message[], tools: readonly unknown[]): string {
    const p = this.profile;
    const generation: Record<string, unknown> = {
      max_tokens: p.generation.max_output_tokens,
    };
    if (p.provider === "deepseek") {
      generation.thinking = { type: p.generation.thinking };
      if (p.generation.reasoning_effort)
        generation.reasoning_effort = p.generation.reasoning_effort;
    }
    if (p.generation.temperature !== undefined)
      generation.temperature = p.generation.temperature;
    return JSON.stringify({
      model: p.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
      ...generation,
    });
  }
  async send(
    body: string,
    limits: RequestLimits,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    if (Buffer.byteLength(body) > limits.max_request_bytes)
      throw new ModelFailure("request_size_limit", "not_generated");
    if (signal.aborted)
      throw new ModelFailure("cancelled_before_send", "not_generated");
    const start = performance.now();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), limits.timeout_ms);
    try {
      const response = await fetch(
        `${this.profile.base_url}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.#key}`,
          },
          body,
          redirect: "error",
          signal: combined,
        },
      );
      const reader = response.body?.getReader();
      if (!reader) throw new ModelFailure("empty_response", "unknown");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limits.max_response_bytes) {
            await reader.cancel();
            throw new ModelFailure("response_size_limit", "unknown");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (combined.aborted) throw new ModelFailure("late_response", "unknown");
      const decoded = Buffer.concat(chunks).toString("utf8");
      // A provider can reflect request credentials. Scrub exact values before any recording.
      const safe = decoded.split(this.#key).join("[REDACTED]");
      if (!response.ok) {
        let usage = normalizeUsage(null);
        try {
          usage = normalizeUsage(obj(JSON.parse(safe)).usage);
        } catch {
          /* Error pages need not be JSON. */
        }
        const rejected = [400, 401, 403, 404, 422, 429].includes(
          response.status,
        );
        const accounting =
          usage.status === "known"
            ? "known"
            : rejected
              ? "not_generated"
              : "unknown";
        throw new ModelFailure(
          response.status === 429 ? "rate_limited" : `http_${response.status}`,
          accounting,
          response.status === 429 &&
            (usage.total_tokens === null || usage.total_tokens === 0),
          usage,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(safe);
      } catch {
        throw new ModelFailure("invalid_response_json", "unknown");
      }
      return parseResponse(raw, this.profile, performance.now() - start);
    } catch (error) {
      if (error instanceof ModelFailure) throw error;
      // Never serialize network exceptions: endpoints and reflected authorization may appear in them.
      throw new ModelFailure(
        combined.aborted ? "request_aborted" : "transport_or_protocol_failure",
        "unknown",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
