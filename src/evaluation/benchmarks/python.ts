import { resolve } from "node:path";
import { obj } from "../../models/validation";
import { bounded, LIMITS } from "../contracts";
import { command, commandEnvironment } from "../process";

/**
 * One bounded JSON request to the trusted Python scorer (`statigent_evaluation.bridge`) through uv.
 * The scorer never receives credentials or executes submitted code.
 */
export async function scorerRequest(
  request: unknown,
  options: {
    signal?: AbortSignal;
    timeout_ms?: number;
    /** Request and response byte limits; DAComp prompts and replies exceed the default. */
    limit?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const limit = options.limit ?? LIMITS.request;
  bounded(request, limit);
  const result = await command(
    [
      "uv",
      "run",
      "--offline",
      "--frozen",
      "python",
      "-m",
      "statigent_evaluation.bridge",
    ],
    {
      input: JSON.stringify(request),
      signal: options.signal,
      timeout_ms: options.timeout_ms ?? 10000,
      stdout_limit: limit,
      env: { ...commandEnvironment(), PYTHONPATH: resolve("python") },
    },
  );
  return obj(JSON.parse(result.stdout));
}
