import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { type Invocation, validateOutput } from "../evaluation/contracts";
import { canonicalJson } from "../modeling/protocol-v2";
import { sha256 } from "../records/store";
import { baselineOptionsSchema } from "./catalog";
import {
  BRIDGE_LIMITS,
  BridgeGate,
  type BridgeRequest,
  JsonlDecoder,
  relativePathSchema,
} from "./protocol";
import type { BaselineRecorder } from "./records";
import {
  environmentIdentity,
  repositoryRoot,
  sourceManifest,
  verifyDatawiseSource,
} from "./source";

export const workerViewSchema = z
  .strictObject({
    protocol_version: z.literal(1),
    run_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    method: z.enum(["autogen", "datawiseagent"]),
    goal: z.string().min(1),
    constraints: z.array(z.string()),
    files: z.array(relativePathSchema),
    output: z.unknown().transform((value) => validateOutput(value, 3)),
    options: baselineOptionsSchema,
    seed: z.number().int().nonnegative(),
  })
  .superRefine((view, ctx) => {
    if (view.method !== view.options.method)
      ctx.addIssue({
        code: "custom",
        message: "Worker method identity mismatch",
      });
  });
export type WorkerView = z.infer<typeof workerViewSchema>;
export function publicWorkerView(i: Invocation, runId: string): WorkerView {
  const options = baselineOptionsSchema.parse(i.config.options);
  return workerViewSchema.parse({
    protocol_version: 1,
    run_id: runId,
    method: options.method,
    goal: i.task.goal,
    constraints: i.task.constraints,
    files: i.task.inputs
      .filter(
        (f) =>
          !i.task.phase_inputs || i.task.phase_inputs.search.includes(f.path),
      )
      .map((f) => f.path),
    output: i.task.output,
    options,
    seed: i.seed,
  });
}
export function workerEnvironment(
  directory: string,
  supplied = process.env,
): Record<string, string> {
  return {
    PATH: supplied.PATH ?? "/usr/bin:/bin",
    HOME: directory,
    TMPDIR: directory,
    LANG: "C.UTF-8",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: join(repositoryRoot, "python"),
    UV_PYTHON_DOWNLOADS: "never",
    UV_CACHE_DIR: join(directory, "uv-cache"),
    UV_NO_SYNC: "1",
  };
}

/** entry/project 仅为受信测试依赖，既不来自配置也不出现在 worker 请求中。 */
async function runWorker(
  options: {
    view: WorkerView;
    directory: string;
    timeout_ms: number;
    signal: AbortSignal;
    recorder: Pick<BaselineRecorder, "event">;
    handle: (
      request: BridgeRequest,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>;
    stopExecution: () => Promise<void>;
  },
  dependencies: { entry?: string; project?: string } = {},
): Promise<void> {
  const view = workerViewSchema.parse(options.view);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: false });
  const project =
    dependencies.project ?? (await environmentIdentity(view.method)).root;
  if (view.method === "datawiseagent" && !dependencies.entry)
    await verifyDatawiseSource();
  const entry =
    dependencies.entry ??
    join(repositoryRoot, "python/statigent_baselines/worker.py");
  const gate = new BridgeGate(view.run_id),
    decoder = new JsonlDecoder();
  const controller = new AbortController();
  let finished = false,
    failure: Error | undefined,
    stderrBytes = 0;
  const process = Bun.spawn(
    [
      "uv",
      "run",
      "--frozen",
      "--offline",
      "--no-sync",
      "--project",
      project,
      "python",
      entry,
    ],
    {
      cwd: directory,
      env: workerEnvironment(directory),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stop = (reason: Error) => {
    failure ??= reason;
    gate.close();
    controller.abort(reason);
    process.kill("SIGKILL");
  };
  const cancel = () => stop(new Error("baseline_worker_cancelled"));
  options.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => stop(new Error("baseline_worker_timed_out")),
    options.timeout_ms,
  );
  const exited = process.exited.then((code) => {
    if (!finished)
      stop(new Error(`baseline_worker_exit_${code}_without_submission`));
    return code;
  });
  try {
    options.signal.throwIfAborted();
    const init = `${JSON.stringify(view)}\n`;
    if (Buffer.byteLength(init) > BRIDGE_LIMITS.request_bytes)
      throw new Error("Worker public view exceeds limit");
    await options.recorder.event("worker_started", {
      method: view.method,
      protocol_version: 1,
      identity: dependencies.entry
        ? { fixture: true }
        : {
            environment: await environmentIdentity(view.method),
            source:
              view.method === "datawiseagent"
                ? {
                    commit: sourceManifest.commit,
                    manifest_sha256: sha256(
                      Buffer.from(canonicalJson(sourceManifest)),
                    ),
                    prompts: sourceManifest.files.filter(
                      (f) =>
                        f.path.includes("/prompts/") ||
                        f.path.startsWith("configs/"),
                    ),
                  }
                : { package: "pyautogen", version: "0.2.35" },
            boundary: await Promise.all(
              [
                "worker.py",
                "bridge.py",
                "import_boundary.py",
                `${view.method === "autogen" ? "autogen" : "datawise"}_worker.py`,
              ].map(async (file) => ({
                path: file,
                sha256: sha256(
                  await readFile(
                    join(repositoryRoot, "python/statigent_baselines", file),
                  ),
                ),
              })),
            ),
          },
    });
    process.stdin.write(init);
    await process.stdin.flush();
    const drainErrors = async () => {
      const reader = process.stderr.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          stderrBytes += item.value.length;
          if (stderrBytes > BRIDGE_LIMITS.stderr_bytes)
            throw new Error("Worker stderr limit exceeded");
          await options.recorder.event("worker_stderr", {
            text: new TextDecoder().decode(item.value),
          });
        }
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      } finally {
        reader.releaseLock();
      }
    };
    const dispatch = async () => {
      const reader = process.stdout.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          const frames = decoder.push(item.value);
          if (frames.length > 1)
            throw new Error("Pipelined worker requests rejected");
          for (const frame of frames) {
            const request = gate.accept(frame);
            await options.recorder.event("worker_request", { request });
            const result = await options.handle(request, controller.signal);
            controller.signal.throwIfAborted();
            const response = gate.settle({
              protocol_version: 1,
              run_id: view.run_id,
              request_id: request.request_id,
              sequence: request.sequence,
              type: "response",
              status: "ok",
              result,
            });
            await options.recorder.event("worker_response", {
              request_id: request.request_id,
              sequence: request.sequence,
              result,
            });
            if (request.type === "submission.finish") finished = true;
            process.stdin.write(response);
            await process.stdin.flush();
          }
        }
        decoder.end();
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      } finally {
        reader.releaseLock();
      }
    };
    const [, , code] = await Promise.all([dispatch(), drainErrors(), exited]);
    if (failure) throw failure;
    if (!finished || code !== 0)
      throw new Error(`baseline_worker_exit_${code}`);
    await options.recorder.event("worker_finished", { code });
  } catch (error) {
    stop(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    gate.close();
    controller.abort();
    process.kill("SIGKILL");
    await process.exited;
  }
}

export async function runTrustedWorker(
  ...args: Parameters<typeof runWorker>
): Promise<void> {
  const [options] = args;
  try {
    await runWorker(...args);
  } catch (error) {
    await options.recorder.event("worker_failed", { error: String(error) });
    throw error;
  } finally {
    // 启动失败同样必须清理；worker 退出不等于实际执行器停止。
    await options.stopExecution();
  }
}
