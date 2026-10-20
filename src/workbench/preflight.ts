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
      message: `请在启动工作台服务的环境中设置 ${options.profile.api_key_env}（模型配置 ${options.profile.id}）`,
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
      message: `无法连接 Docker：${firstLine(daemon.stderr) || "服务端无响应"}`,
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
      message: `本机没有执行镜像 ${options.image}，请按 docs/execution-runtime.md 构建`,
    });
    return problems;
  }
  try {
    validateImageBackend(options.backend, JSON.parse(image.stdout || "null"));
  } catch (error) {
    problems.push({
      code: "image_incompatible",
      message: `镜像 ${options.image} 不支持 ${options.backend} 后端：${error instanceof Error ? error.message : "标签无效"}`,
    });
  }
  return problems;
}
