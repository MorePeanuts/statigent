import {
  type ModelProfile,
  resolveCredential,
  validateProfile,
} from "./config";
import { checkImages, DEFAULT_IMAGE_LIMITS, type ImageLimits } from "./images";
import { integer, obj, str } from "./validation";
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
/** Image parts carry raw bytes; the client validates and encodes them as data URLs, never remote URLs. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: Uint8Array };
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
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
  requestBody(
    messages: Message[],
    tools: readonly unknown[],
    images?: ImageLimits,
  ): string;
  send(
    body: string,
    limits: RequestLimits,
    signal: AbortSignal,
  ): Promise<ModelResponse>;
}
/**
 * Serializes messages for chat-completions. Image parts are only accepted in user messages of a
 * vision-capable profile and are checked locally before anything is sent.
 */
export function serializeMessages(
  profile: ModelProfile,
  messages: Message[],
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): unknown[] {
  const images = messages.flatMap((m) =>
    m.role === "user" && Array.isArray(m.content)
      ? m.content.flatMap((p) => (p.type === "image" ? [p.data] : []))
      : [],
  );
  if (images.length && !profile.capabilities.vision)
    throw new Error("vision_capability_required");
  const infos = checkImages(images, limits);
  let next = 0;
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") {
      if (typeof m.content !== "string" && m.content !== null)
        throw new Error("image_parts_only_in_user_messages");
      return m;
    }
    return {
      role: "user",
      content: m.content.map((p) => {
        if (p.type === "text") return { type: "text", text: p.text };
        const info = infos[next++];
        if (!info) throw new Error("image_accounting_error");
        return {
          type: "image_url",
          image_url: {
            url: `data:${info.mime};base64,${Buffer.from(p.data).toString("base64")}`,
          },
        };
      }),
    };
  });
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
  requestBody(
    messages: Message[],
    tools: readonly unknown[],
    images: ImageLimits = DEFAULT_IMAGE_LIMITS,
  ): string {
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
    // A request without tools (scoring) must not advertise tool_choice either.
    return JSON.stringify({
      model: p.model,
      messages: serializeMessages(p, messages, images),
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
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
        let invalidUsage = false;
        try {
          const body = obj(JSON.parse(safe));
          if (body.usage !== undefined && body.usage !== null) {
            invalidUsage = true;
            usage = normalizeUsage(body.usage);
            invalidUsage = false;
          }
        } catch {
          /* Error pages need not be JSON. */
        }
        const rejected = [400, 401, 403, 404, 422, 429].includes(
          response.status,
        );
        const accounting =
          usage.status === "known"
            ? "known"
            : invalidUsage ||
                usage.input_tokens !== null ||
                usage.output_tokens !== null
              ? "unknown"
              : rejected
                ? "not_generated"
                : "unknown";
        throw new ModelFailure(
          response.status === 429 ? "rate_limited" : `http_${response.status}`,
          accounting,
          response.status === 429 &&
            accounting !== "unknown" &&
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
/**
 * Single-turn request without tools, used by scorers. Truncated replies, tool calls and empty content are
 * failures with their known usage, never usable output.
 */
export async function completeText(
  client: ModelClient,
  messages: Message[],
  limits: RequestLimits & { images?: ImageLimits },
  signal: AbortSignal,
): Promise<ModelResponse & { text: string }> {
  let body: string;
  try {
    body = client.requestBody(messages, [], limits.images);
  } catch (error) {
    throw new ModelFailure(
      error instanceof Error ? error.message : "invalid_request",
      "not_generated",
    );
  }
  const response = await client.send(body, limits, signal);
  const fail = (code: string) =>
    new ModelFailure(
      code,
      response.usage.status === "known" ? "known" : "unknown",
      false,
      response.usage,
    );
  if (response.finish_reason === "length") throw fail("truncated");
  if (response.message.tool_calls || response.finish_reason === "tool_calls")
    throw fail("unexpected_tool_calls");
  if (response.finish_reason !== "stop") throw fail(response.finish_reason);
  const text = response.message.content ?? "";
  if (!text.trim()) throw fail("empty_content");
  return { ...response, text };
}
