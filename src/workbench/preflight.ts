import { execFile } from "node:child_process";
import type { ExecutionBackend } from "../execution/backend";
import { validateImageBackend } from "../execution/docker";
import { type ModelProfile, resolveCredential } from "../models/config";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export interface PreflightProblem {
  code:
    | "model_key_missing"
    | "docker_unavailable"
    | "image_missing"
    | "image_incompatible";
  message: string;
}

export const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : // Spawn failures (e.g. docker not installed) and timeouts carry no exit code.
                -1;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      },
    );
  });

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 300) ?? "";
}

/**
 * Checks what a run needs from this machine before it is started, so a missing key or image is
 * reported as such instead of surfacing later as a failed run. Every problem found is returned.
 */
export async function checkRunPrerequisites(
  options: {
    profile: ModelProfile;
    backend: ExecutionBackend;
    image: string;
  },
  environment: Record<string, string | undefined> = process.env,
  run: CommandRunner = runCommand,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];
  try {
    resolveCredential(options.profile, environment);
  } catch {
    problems.push({
      code: "model_key_missing",
      message: `Set ${options.profile.api_key_env} in the workbench server's environment for model profile ${options.profile.id}`,
    });
  }
  const daemon = await run(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    10000,
  );
  if (daemon.code !== 0) {
    problems.push({
      code: "docker_unavailable",
      message: `Docker is not reachable: ${firstLine(daemon.stderr) || "no server response"}`,
    });
    return problems;
  }
  const image = await run(
    "docker",
    ["image", "inspect", "--format", "{{json .Config.Labels}}", options.image],
    10000,
  );
  if (image.code !== 0) {
    problems.push({
      code: "image_missing",
      message: `Execution image ${options.image} is not available locally; build it as described in docs/execution-runtime.md`,
    });
    return problems;
  }
  try {
    validateImageBackend(options.backend, JSON.parse(image.stdout || "null"));
  } catch (error) {
    problems.push({
      code: "image_incompatible",
      message: `Image ${options.image} cannot run the ${options.backend} backend: ${error instanceof Error ? error.message : "invalid labels"}`,
    });
  }
  return problems;
}
