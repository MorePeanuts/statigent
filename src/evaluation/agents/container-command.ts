import { resolve } from "node:path";
import { integer, keys, obj, str, strings } from "../../models/validation";
import {
  type AgentAdapter,
  bounded,
  emptyUsage,
  LIMITS,
  type Submission,
  validateInvocation,
  validateSubmission,
} from "../contracts";
import { verifyFiles } from "../files";
import { command } from "../process";
import { cleanupContainers, inspectImage } from "./docker";

export function commandOptions(value: unknown): Record<string, unknown> {
  const x = obj(value);
  keys(x, ["image", "argv", "cpus", "memory_bytes", "pids", "workspace_bytes"]);
  const argv = strings(x.argv, "argv");
  if (!argv.length || argv.some((a) => a.includes("\0")))
    throw new Error("Invalid argv");
  return {
    image: str(x.image, "image"),
    argv,
    cpus: integer(x.cpus ?? 1, "cpus"),
    memory_bytes: integer(x.memory_bytes ?? 536870912, "memory_bytes"),
    pids: integer(x.pids ?? 64, "pids"),
    workspace_bytes: integer(x.workspace_bytes ?? 67108864, "workspace_bytes"),
  };
}
export function parseCommandResponse(
  stdout: string,
  unitId: string,
): Submission {
  const lines = stdout.trim().split("\n");
  if (lines.length !== 1) throw new Error("Expected one response line");
  const s = validateSubmission(JSON.parse(lines[0] ?? ""), unitId);
  if (
    s.native_run !== null ||
    s.usage.source !== "not_applicable" ||
    s.record_error ||
    s.cleanup_error !== null
  )
    throw new Error(
      "External command cannot claim host records or model usage",
    );
  return s;
}
export function containerCommandAdapter(): AgentAdapter {
  return {
    id: "container-command",
    version: "1",
    capabilities: {
      schema_version: 1,
      output: "text",
      model: "none",
      seed: "execution",
      isolation: "docker",
      model_budget: false,
      usage: "not_applicable",
    },
    options: commandOptions,
    async preflight(config) {
      if (config.model)
        throw new Error("Offline command does not support models");
      return {
        ...(await inspectImage(
          str(commandOptions(config.options).image, "image"),
        )),
        capabilities: this.capabilities,
      };
    },
    async run(value, signal) {
      const i = validateInvocation(value);
      const o = commandOptions(i.config.options);
      const s: Submission = {
        schema_version: 1,
        unit_id: i.unit_id,
        status: "failed",
        answer_text: "",
        reason: "command_failed",
        artifacts: [],
        native_run: null,
        usage: emptyUsage("not_applicable"),
        record_error: false,
        cleanup_error: null,
      };
      const deadline = Date.now() + i.budget.timeout_ms;
      const controller = new AbortController();
      const combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), i.budget.timeout_ms);
      try {
        await verifyFiles(i.input_root, i.task.inputs);
        combined.throwIfAborted();
        const image = await inspectImage(str(o.image, "image"));
        combined.throwIfAborted();
        const argv = strings(o.argv, "argv");
        const inputRoot = resolve(i.input_root);
        if (inputRoot.includes(",")) throw new Error("Invalid bind mount path");
        const args = [
          "docker",
          "run",
          "--name",
          `statigent-eval-${i.evaluation_id}-${i.unit_id}`,
          "--label",
          `org.statigent.evaluation=${i.evaluation_id}`,
          "--label",
          `org.statigent.unit=${i.unit_id}`,
          "-i",
          "--network",
          "none",
          "--read-only",
          "--user",
          "10001:10001",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--cpus",
          String(o.cpus),
          "--memory",
          String(o.memory_bytes),
          "--memory-swap",
          String(o.memory_bytes),
          "--pids-limit",
          String(o.pids),
          "--tmpfs",
          `/workspace:rw,noexec,nosuid,nodev,size=${o.workspace_bytes},uid=10001,gid=10001,mode=700`,
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
          "--mount",
          `type=bind,source=${inputRoot},target=/input,readonly`,
          "--workdir",
          "/workspace",
          "--env",
          "HOME=/tmp",
          "--env",
          `PYTHONHASHSEED=${i.seed}`,
        ];
        for (const name of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
          "no_proxy",
        ])
          args.push("--env", `${name}=`);
        args.push(
          "--entrypoint",
          argv[0] ?? "",
          str(image.image_id, "image_id"),
          ...argv.slice(1),
        );
        const request = { ...i, input_root: "/input", run_root: "/workspace" };
        bounded(request, LIMITS.request);
        const response = await command(args, {
          input: `${JSON.stringify(request)}\n`,
          timeout_ms: Math.max(1, deadline - Date.now()),
          signal: combined,
          stdout_limit: LIMITS.response,
          stderr_limit: LIMITS.stderr,
        });
        Object.assign(s, parseCommandResponse(response.stdout, i.unit_id));
      } catch (error) {
        s.status = signal?.aborted
          ? "cancelled"
          : controller.signal.aborted || Date.now() >= deadline
            ? "timed_out"
            : "failed";
        s.reason = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
        try {
          await cleanupContainers(i.evaluation_id, i.unit_id);
        } catch (error) {
          s.cleanup_error =
            error instanceof Error ? error.message : String(error);
          s.status = "failed";
        }
      }
      return validateSubmission(s, i.unit_id);
    },
  };
}
