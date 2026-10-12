import { integer, keys, obj, str } from "./validation";

export interface ModelProfile {
  id: string;
  provider: "deepseek" | "generic";
  protocol: "chat-completions";
  base_url: string;
  model: string;
  display_name: string;
  api_key_env: string;
  allow_loopback_http: boolean;
  capabilities: { tool_calls: true; thinking: boolean; vision: boolean };
  generation: {
    max_output_tokens: number;
    thinking?: "enabled" | "disabled";
    reasoning_effort?: "high" | "max";
    temperature?: number;
  };
}
export function validateProfile(value: unknown): ModelProfile {
  const x = obj(value);
  keys(x, [
    "id",
    "provider",
    "protocol",
    "base_url",
    "model",
    "display_name",
    "api_key_env",
    "allow_loopback_http",
    "capabilities",
    "generation",
  ]);
  if (x.provider !== "deepseek" && x.provider !== "generic")
    throw new Error("Unsupported provider");
  if (x.protocol !== "chat-completions")
    throw new Error("Unsupported protocol");
  const url = new URL(str(x.base_url, "base_url"));
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Invalid base_url credentials/query/fragment");
  if (
    x.allow_loopback_http !== undefined &&
    typeof x.allow_loopback_http !== "boolean"
  )
    throw new Error("Invalid allow_loopback_http");
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && local && x.allow_loopback_http === true)
  )
    throw new Error("HTTPS required; explicit loopback HTTP only");
  const env = str(x.api_key_env, "api_key_env");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))
    throw new Error("Invalid api_key_env");
  const cap = obj(x.capabilities);
  keys(cap, ["tool_calls", "thinking", "vision"]);
  if (
    cap.tool_calls !== true ||
    typeof cap.thinking !== "boolean" ||
    (cap.vision !== undefined && typeof cap.vision !== "boolean")
  )
    throw new Error("Unsupported capabilities");
  const gen = obj(x.generation);
  keys(gen, [
    "max_output_tokens",
    "thinking",
    "reasoning_effort",
    "temperature",
  ]);
  const generation: ModelProfile["generation"] = {
    max_output_tokens: integer(gen.max_output_tokens, "max_output_tokens"),
  };
  if (gen.thinking !== undefined) {
    if (
      x.provider !== "deepseek" ||
      !cap.thinking ||
      !["enabled", "disabled"].includes(String(gen.thinking))
    )
      throw new Error("Unsupported thinking mode");
    generation.thinking = gen.thinking as "enabled" | "disabled";
  }
  if (x.provider === "deepseek" && gen.thinking === undefined)
    throw new Error("DeepSeek thinking must be explicit");
  if (x.provider === "generic" && cap.thinking)
    throw new Error("Generic thinking is not supported");
  if (gen.reasoning_effort !== undefined) {
    if (
      gen.thinking !== "enabled" ||
      !["high", "max"].includes(String(gen.reasoning_effort))
    )
      throw new Error("Unsupported reasoning_effort");
    generation.reasoning_effort = gen.reasoning_effort as "high" | "max";
  }
  if (gen.temperature !== undefined) {
    if (
      gen.thinking === "enabled" ||
      typeof gen.temperature !== "number" ||
      !Number.isFinite(gen.temperature) ||
      gen.temperature < 0 ||
      gen.temperature > 2
    )
      throw new Error("Unsupported temperature");
    generation.temperature = gen.temperature;
  }
  return {
    id: str(x.id, "id"),
    provider: x.provider,
    protocol: "chat-completions",
    base_url: url.href.replace(/\/$/, ""),
    model: str(x.model, "model"),
    display_name: str(x.display_name, "display_name"),
    api_key_env: env,
    allow_loopback_http: x.allow_loopback_http === true,
    // Absent vision means text-only, so existing profile files stay valid.
    capabilities: {
      tool_calls: true,
      thinking: cap.thinking,
      vision: cap.vision === true,
    },
    generation,
  };
}
export function selectProfile(value: unknown, id: string): ModelProfile {
  if (!Array.isArray(value)) throw new Error("Models must be an array");
  const profiles = value.map(validateProfile);
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length)
    throw new Error("Duplicate model profile ID");
  const profile = profiles.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown model profile: ${id}`);
  return profile;
}
export function resolveCredential(
  profile: ModelProfile,
  environment: Record<string, string | undefined> = process.env,
): string {
  const key = environment[profile.api_key_env];
  if (!key?.trim() || /[\r\n]/.test(key))
    throw new Error(
      `Missing or invalid credential environment variable: ${profile.api_key_env}`,
    );
  return key;
}
// Construct from validated fields, never spread environment, headers, or provider responses.
export function profileSnapshot(profile: ModelProfile): ModelProfile {
  return validateProfile(profile);
}
