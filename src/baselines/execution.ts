import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeFile } from "../evaluation/files";
import { createSession } from "../execution/factory";
import type {
  ArtifactRef,
  SessionConfig,
  SessionObserver,
} from "../execution/protocol";
import { sha256 } from "../records/store";
import { BRIDGE_LIMITS, relativePathSchema } from "./protocol";

export type BaselineSession = Awaited<ReturnType<typeof createSession>>;
/** 只返回已经由隔离执行器收集、校验并保存的本次产物。 */
export class BaselineArtifacts {
  private files = new Map<string, ArtifactRef>();
  private bytes = 0;
  constructor(
    readonly directory: string,
    readonly maxBytes: number,
  ) {}
  async capture(
    message: Parameters<NonNullable<SessionObserver["onArtifact"]>>[0],
  ) {
    const path = relativePathSchema.parse(message.path);
    const data = Buffer.from(message.data_base64, "base64");
    if (
      data.toString("base64") !== message.data_base64 ||
      this.bytes + data.length > this.maxBytes
    )
      throw new Error("Invalid/oversized baseline artifact");
    const artifactId = randomUUID();
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, artifactId), data, {
      flag: "wx",
      mode: 0o600,
    });
    const ref: ArtifactRef = {
      artifact_id: artifactId,
      path,
      sha256: sha256(data),
      size_bytes: data.length,
      mime_type: message.mime_type,
      complete: true,
    };
    this.bytes += data.length;
    this.files.set(path, ref);
    return ref;
  }
  list() {
    return [...this.files.values()].map((x) => ({ ...x }));
  }
  clearVisible() {
    // 历史文件保留供审计，但新内核不能读到重放前的产物。
    this.files.clear();
  }
  async read(path: string) {
    const ref = this.files.get(relativePathSchema.parse(path));
    if (!ref) throw new Error("Artifact not collected in this run");
    const actual = await describeFile(this.directory, ref.artifact_id);
    if (actual.sha256 !== ref.sha256 || actual.bytes !== ref.size_bytes)
      throw new Error("Collected artifact changed");
    return readFile(join(this.directory, ref.artifact_id));
  }
  async response(path: string) {
    const data = await this.read(path);
    if ((data.length * 4) / 3 + 2048 > BRIDGE_LIMITS.response_bytes)
      throw new Error("Artifact exceeds bridge response limit");
    return {
      path,
      data_base64: data.toString("base64"),
      sha256: sha256(data),
      bytes: data.length,
    };
  }
}

export async function baselineExecution(
  options: {
    config: SessionConfig;
    artifactDirectory: string;
    event: (type: string, details: Record<string, unknown>) => Promise<void>;
    allowKnownReplay?: boolean;
    maxExecutions?: number;
  },
  dependencies: { create?: typeof createSession } = {},
) {
  const artifacts = new BaselineArtifacts(
    options.artifactDirectory,
    options.config.limits.max_artifacts_bytes,
  );
  const started = performance.now();
  const create = dependencies.create ?? createSession;
  const observer: SessionObserver = {
    onEvent: (event) => options.event("execution_event", { event }),
    onArtifact: (message) => artifacts.capture(message),
  };
  let session = await create(options.config, observer);
  let active = false,
    closed = false,
    known = true,
    epoch = 1,
    executions = 0;
  const remaining = () =>
    options.config.limits.task_timeout_ms - (performance.now() - started);
  return {
    get session() {
      return session;
    },
    get stateKnown() {
      return known && !active && !closed;
    },
    artifacts,
    seal() {
      if (closed || active || !known)
        throw new Error("Cannot freeze execution in this state");
      closed = true;
    },
    async closeAfterSnapshot() {
      closed = true;
      await session.closeAfterSnapshot();
    },
    usage: () => ({ executions, kernel_epoch: epoch }),
    async restart(
      reason: "post-filter" | "plan-rollback",
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      if (
        !options.allowKnownReplay ||
        options.config.backend === "fresh-script" ||
        closed ||
        active ||
        !known ||
        remaining() <= 0 ||
        !["post-filter", "plan-rollback"].includes(reason)
      )
        throw new Error("Known-history replay not allowed in this state");
      active = true;
      known = false;
      try {
        await options.event("replay_requested", {
          reason,
          kernel_epoch: epoch,
          executions,
        });
        await session.close();
        signal.throwIfAborted();
        if (remaining() <= 0) throw new Error("Execution deadline reached");
        artifacts.clearVisible();
        session = await create(
          {
            ...options.config,
            session_id: undefined,
            limits: {
              ...options.config.limits,
              task_timeout_ms: Math.max(1, Math.floor(remaining())),
            },
          },
          observer,
        );
        if (signal.aborted || closed) {
          await session.close();
          signal.throwIfAborted();
          throw new Error("Execution closed during replay");
        }
        epoch++;
        known = true;
        await options.event("replay_started", {
          reason,
          kernel_epoch: epoch,
          session_id: session.sessionId,
          executions,
        });
        return { kernel_epoch: epoch };
      } finally {
        active = false;
      }
    },
    async execute(code: string, requestId: string, signal: AbortSignal) {
      if (closed || active || !known)
        throw new Error("Execution closed, busy or unknown");
      signal.throwIfAborted();
      if (remaining() <= 0 || executions >= (options.maxExecutions ?? 300))
        throw new Error("Execution budget exhausted");
      executions++;
      active = true;
      known = false;
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => {
        cancellation ??= session.cancel(requestId);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await options.event("execution_requested", {
          request_id: requestId,
          code,
          kernel_epoch: epoch,
          execution_number: executions,
        });
        signal.throwIfAborted();
        const result = await session.execute(code, { requestId });
        known =
          ["ok", "error"].includes(result.status) &&
          (options.config.backend === "fresh-script" ||
            ("kernel_available" in result && result.kernel_available)) &&
          !signal.aborted &&
          result.persistence_complete;
        await options.event("execution_completed", {
          request_id: requestId,
          result,
          kernel_epoch: epoch,
        });
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
        await cancellation;
        active = false;
      }
    },
    async close() {
      closed = true;
      await session.close();
    },
  };
}
