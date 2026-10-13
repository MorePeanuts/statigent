import { createHash, randomUUID } from "node:crypto";
import {
  FramedDockerTransport,
  safeRelativePath,
  type TransportMetadata,
} from "./docker";
import {
  type ArtifactRef,
  identifier,
  ProtocolError,
  type SessionConfig,
  type SessionObserver,
  validateConfig,
} from "./protocol";
import {
  parseScriptMessage,
  type ScriptArtifact,
  type ScriptMessage,
  type ScriptRequest,
  type ScriptResult,
  type ScriptStatus,
} from "./script-protocol";

export type ScriptTransport = Pick<
  FramedDockerTransport<ScriptMessage, ScriptRequest>,
  "start" | "send" | "stop" | "containerName"
>;
interface Pending {
  request: Extract<ScriptRequest, { type: "execute" }>;
  received: number;
  sent?: number;
  preview: string;
  truncated: boolean;
  artifacts: ArtifactRef[];
  complete: boolean;
  reason?: "timed_out" | "cancelled" | "output_limit_exceeded";
  timer?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  resolve(result: ScriptResult): void;
}
interface Waiter {
  type: string;
  resolve(message: ScriptMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class ScriptSession {
  readonly sessionId: string;
  readonly runId: string;
  metadata?: TransportMetadata;
  closeResult?: {
    status: string;
    cleanup_error?: string;
    elapsed_ms: number;
    wall_time_ms: number;
  };
  private state:
    | "starting"
    | "ready"
    | "busy"
    | "closing"
    | "failed"
    | "closed" = "starting";
  private queue: Pending[] = [];
  private active?: Pending;
  private ids = new Set<string>();
  private sequence = 0;
  private waiters = new Map<string, Waiter>();
  private events = Promise.resolve();
  private created = performance.now();
  private taskTimer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private failing?: Promise<void>;
  private recordFailed = false;
  private status = "ok";
  private outputBytes = 0;
  private artifactBytes = 0;
  private outputIndex = 0;
  private constructor(
    private readonly config: SessionConfig,
    private readonly observer?: SessionObserver,
    private readonly transport: ScriptTransport = new FramedDockerTransport(
      parseScriptMessage,
    ),
  ) {
    validateConfig(config);
    if (config.backend !== "fresh-script")
      throw new ProtocolError("Script session requires fresh-script");
    this.runId = config.run_id;
    this.sessionId = config.session_id ?? randomUUID();
  }
  get containerName() {
    return this.transport.containerName;
  }
  private base(requestId: string = randomUUID()) {
    return {
      protocol_version: 2 as const,
      backend: "fresh-script" as const,
      request_id: requestId,
      session_id: this.sessionId,
    };
  }
  private async emit(type: string, detail: Record<string, unknown> = {}) {
    if (this.recordFailed) throw new Error("record persistence failed");
    try {
      await this.observer?.onEvent({
        type,
        at: new Date().toISOString(),
        run_id: this.runId,
        session_id: this.sessionId,
        backend: "fresh-script",
        ...detail,
      });
    } catch (error) {
      this.recordFailed = true;
      throw error;
    }
  }
  static async create(
    config: SessionConfig,
    observer?: SessionObserver,
    transport?: ScriptTransport,
  ) {
    const session = new ScriptSession(config, observer, transport);
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.fail(error);
      await session.close();
      throw error;
    }
  }
  private async start() {
    await this.emit("session_start", { config: this.config });
    this.taskTimer = setTimeout(() => {
      this.status = "task_timeout";
      void this.fail(new Error("task timeout"), "timed_out");
    }, this.config.limits.task_timeout_ms);
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + this.config.limits.startup_timeout_ms;
    try {
      this.metadata = await Promise.race([
        this.transport.start(
          this.config,
          this.sessionId,
          (message) => {
            this.events = this.events
              .then(() => this.receive(message))
              .catch((error) => this.fail(error));
            return this.events;
          },
          (error) => {
            void this.fail(error);
          },
        ),
        new Promise<never>((_, reject) => {
          startupTimer = setTimeout(
            () => reject(new Error("startup deadline exceeded")),
            this.config.limits.startup_timeout_ms,
          );
        }),
      ]);
      if (this.state !== "starting") throw new Error("startup stopped");
      const ready = await this.control(
        {
          ...this.base(),
          type: "init",
          seed: this.config.seed,
          limits: this.config.limits,
        },
        Math.max(1, deadline - performance.now()),
      );
      if (ready.type !== "ready" || !ready.session_available)
        throw new ProtocolError("Script runner unavailable");
      this.metadata.dependencies = ready.dependencies;
      await this.emit("ready", {
        metadata: this.metadata,
        initialization: ready.initialization,
      });
      this.state = "ready";
    } finally {
      clearTimeout(startupTimer);
    }
  }
  execute(
    code: string,
    options: { requestId?: string } = {},
  ): Promise<ScriptResult> {
    const id = options.requestId ?? randomUUID();
    identifier(id, "request_id");
    if (
      typeof code !== "string" ||
      Buffer.byteLength(code) > this.config.limits.max_code_bytes
    )
      return Promise.reject(new ProtocolError("Invalid script size"));
    if (!["ready", "busy"].includes(this.state))
      return Promise.reject(new Error(`Session ${this.state}`));
    if (
      this.ids.has(id) ||
      (this.active && this.queue.length >= this.config.limits.queue_capacity)
    )
      return Promise.reject(
        new ProtocolError("Duplicate request or queue full"),
      );
    this.ids.add(id);
    return new Promise((resolve) => {
      this.queue.push({
        request: {
          ...this.base(id),
          type: "execute",
          execution_id: randomUUID(),
          execution_seq: 0,
          code,
        },
        received: performance.now(),
        preview: "",
        truncated: false,
        artifacts: [],
        complete: true,
        resolve,
      });
      void this.pump();
    });
  }
  private async pump() {
    if (this.active || this.state !== "ready") return;
    const p = this.queue.shift();
    if (!p) return;
    this.active = p;
    this.state = "busy";
    p.request.execution_seq = this.sequence + 1;
    try {
      await this.emit("dispatch", {
        request: p.request,
        code: p.request.code,
        code_sha256: createHash("sha256").update(p.request.code).digest("hex"),
        request_id: p.request.request_id,
        execution_id: p.request.execution_id,
        execution_seq: p.request.execution_seq,
      });
      if (p.reason || this.state !== "busy") {
        await this.finish(p, this.result(p, p.reason ?? "cancelled"));
        void this.pump();
        return;
      }
      p.sent = performance.now();
      this.sequence++;
      p.timer = setTimeout(() => {
        void this.interrupt(p, "timed_out");
      }, this.config.limits.cell_timeout_ms);
      await this.transport.send(p.request);
    } catch (error) {
      await this.fail(error);
    }
  }
  private control(
    request: ScriptRequest,
    timeout = this.config.limits.interrupt_grace_ms,
  ): Promise<ScriptMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(request.request_id);
        reject(new Error(`${request.type} timeout`));
      }, timeout);
      this.waiters.set(request.request_id, {
        type: request.type,
        resolve,
        reject,
        timer,
      });
      void this.transport.send(request).catch((error) => {
        clearTimeout(timer);
        this.waiters.delete(request.request_id);
        reject(error);
      });
    });
  }
  private async receive(message: ScriptMessage) {
    if (this.state === "failed" || this.state === "closed") return;
    if (
      message.session_id !== this.sessionId ||
      message.protocol_version !== 2 ||
      message.backend !== "fresh-script"
    )
      throw new ProtocolError("Script identity mismatch");
    const w = this.waiters.get(message.request_id);
    if (message.type === "ready" || message.type === "control") {
      if (
        !w ||
        (message.type === "ready"
          ? w.type !== "init"
          : w.type !== message.operation)
      )
        throw new ProtocolError("Unexpected control");
      if (
        message.type === "control" &&
        (!message.persistence_complete || message.limit_exceeded)
      )
        this.status = "incomplete_artifacts";
      clearTimeout(w.timer);
      this.waiters.delete(message.request_id);
      w.resolve(message);
      return;
    }
    if (message.type === "diagnostic") {
      await this.emit("diagnostic", { message });
      return;
    }
    if (
      message.type === "artifact" &&
      w?.type === "collect" &&
      message.execution_id === undefined
    ) {
      await this.artifact(message);
      return;
    }
    const p = this.active;
    if (
      !p ||
      message.request_id !== p.request.request_id ||
      message.execution_id !== p.request.execution_id ||
      message.execution_seq !== p.request.execution_seq
    )
      throw new ProtocolError("Unknown or late script output/result");
    if (message.type === "artifact") {
      await this.artifact(message, p);
      return;
    }
    if (message.type === "output") {
      this.outputBytes += Buffer.byteLength(JSON.stringify(message.output));
      if (this.outputBytes > this.config.limits.max_output_bytes) {
        p.complete = false;
        void this.interrupt(p, "output_limit_exceeded");
        return;
      }
      await this.emit("output", { message });
      const out = message.output;
      const preview =
        out.output_type === "stream"
          ? out.text
          : out.output_type === "error"
            ? `${out.ename}: ${out.evalue}\n`
            : "data" in out
              ? (out.data["text/plain"] ?? "")
              : "";
      const room = this.config.limits.preview_chars - p.preview.length;
      p.preview += preview.slice(0, room);
      p.truncated ||= preview.length > room;
      if ("data" in out)
        for (const [mime, value] of Object.entries(out.data)) {
          if (
            mime === "text/plain" &&
            value.length <= this.config.limits.preview_chars
          )
            continue;
          await this.artifact(
            {
              ...this.base(message.request_id),
              type: "artifact",
              execution_id: message.execution_id,
              execution_seq: message.execution_seq,
              path: `outputs/${message.execution_id}/${++this.outputIndex}.${mime === "image/png" ? "png" : mime === "text/html" ? "html" : "txt"}`,
              mime_type: mime,
              data_base64:
                mime === "image/png"
                  ? value
                  : Buffer.from(value).toString("base64"),
            },
            p,
          );
        }
      return;
    }
    const result = {
      ...this.result(p, p.reason ?? message.status),
      started: message.started,
      process: message.process,
      session_available: message.session_available,
      elapsed_ms: message.elapsed_ms,
      timing: message.timing,
      persistence_complete: p.complete && message.persistence_complete,
      ...(message.error ? { error: message.error } : {}),
    };
    await this.finish(p, result);
    if (!message.session_available)
      await this.fail(new Error("script session lost"));
    else if (this.state === "ready") void this.pump();
  }
  private async artifact(message: ScriptArtifact, p?: Pending) {
    const size = Buffer.byteLength(message.data_base64, "base64");
    if (
      !safeRelativePath(message.path) ||
      ![
        "image/png",
        "image/jpeg",
        "text/markdown",
        "text/plain",
        "text/csv",
        "text/html",
        "application/json",
        "application/octet-stream",
      ].includes(message.mime_type)
    )
      throw new ProtocolError("Invalid artifact path or MIME");
    this.artifactBytes += size + Buffer.byteLength(message.path) + 128;
    if (
      size > this.config.limits.max_artifact_bytes ||
      this.artifactBytes > this.config.limits.max_artifacts_bytes
    ) {
      if (p) {
        p.complete = false;
        void this.interrupt(p, "output_limit_exceeded");
      }
      this.status = "output_limit_exceeded";
      return;
    }
    const artifact = await this.observer?.onArtifact?.(message);
    if (artifact) {
      p?.artifacts.push(artifact);
      await this.emit("artifact", { message, artifact });
    }
  }
  private result(
    p: Pending,
    status: ScriptStatus,
    available = this.state !== "failed",
  ): ScriptResult {
    return {
      ...this.base(p.request.request_id),
      execution_id: p.request.execution_id,
      ...(p.sent === undefined
        ? {}
        : { execution_seq: p.request.execution_seq }),
      started: false,
      process: null,
      status,
      session_available: available,
      elapsed_ms: p.sent === undefined ? 0 : performance.now() - p.sent,
      waiting_ms: (p.sent ?? performance.now()) - p.received,
      persistence_complete: p.complete,
      memory_preserved: false,
      files_policy: "task-workspace",
      preview: p.preview,
      preview_truncated: p.truncated,
      artifacts: p.artifacts,
      timing: {
        process_startup_ms: null,
        execution_ms: null,
        collection_ms: null,
        cleanup_ms: null,
      },
      partial_state_possible: p.sent !== undefined && status !== "ok",
    };
  }
  private async finish(p: Pending, result: ScriptResult) {
    clearTimeout(p.timer);
    clearTimeout(p.grace);
    await this.emit("finish", { result });
    if (this.active === p) {
      this.active = undefined;
      if (this.state === "busy") this.state = "ready";
    }
    p.resolve(result);
  }
  async cancel(requestId: string) {
    const i = this.queue.findIndex((p) => p.request.request_id === requestId);
    if (i >= 0) {
      const p = this.queue.splice(i, 1)[0];
      if (p) {
        try {
          await this.finish(p, this.result(p, "cancelled"));
        } catch (e) {
          p.resolve(this.result(p, "cancelled", false));
          await this.fail(e);
        }
      }
      return true;
    }
    if (this.active?.request.request_id === requestId) {
      await this.interrupt(this.active, "cancelled");
      return true;
    }
    return false;
  }
  private async interrupt(p: Pending, reason: NonNullable<Pending["reason"]>) {
    if (this.active !== p || p.reason) return;
    p.reason = reason;
    clearTimeout(p.timer);
    if (p.sent === undefined) return;
    try {
      await this.emit("interrupt", {
        request_id: p.request.request_id,
        execution_id: p.request.execution_id,
        reason,
      });
      p.grace = setTimeout(() => {
        void this.fail(new Error("script interrupt unconfirmed"), reason);
      }, this.config.limits.interrupt_grace_ms);
      await this.control({
        ...this.base(),
        type: "interrupt",
        target_request_id: p.request.request_id,
        reason,
      });
    } catch (e) {
      if (this.active === p) await this.fail(e, reason);
    }
  }
  private fail(
    error: unknown,
    status: ScriptStatus = "session_lost",
  ): Promise<void> {
    this.failing ??= (async () => {
      this.state = "failed";
      if (this.status === "ok") this.status = status;
      clearTimeout(this.taskTimer);
      for (const w of this.waiters.values()) {
        clearTimeout(w.timer);
        w.reject(new Error(String(error)));
      }
      this.waiters.clear();
      let cleanup: string | undefined;
      try {
        await this.transport.stop();
      } catch (e) {
        cleanup = String(e);
      }
      const pending = [...(this.active ? [this.active] : []), ...this.queue];
      this.queue = [];
      this.active = undefined;
      for (const p of pending) {
        const result = {
          ...this.result(
            p,
            p.sent === undefined ? "cancelled" : (p.reason ?? status),
            false,
          ),
          persistence_complete: false,
          diagnostic: String(error),
        };
        clearTimeout(p.timer);
        clearTimeout(p.grace);
        try {
          await this.emit("finish", { result });
        } catch {
          this.recordFailed = true;
        }
        p.resolve(result);
      }
      this.closeResult = {
        status: this.status,
        ...(cleanup ? { cleanup_error: cleanup } : {}),
        elapsed_ms: 0,
        wall_time_ms: performance.now() - this.created,
      };
      try {
        await this.emit("failure", {
          status: this.status,
          message: String(error),
        });
      } catch {
        this.recordFailed = true;
      }
    })();
    return this.failing;
  }
  close(): Promise<void> {
    this.closing ??= this.closeInternal();
    return this.closing;
  }
  private async closeInternal() {
    const begin = performance.now();
    clearTimeout(this.taskTimer);
    const failed = this.state === "failed";
    this.state = failed ? "failed" : "closing";
    let cleanup = this.closeResult?.cleanup_error;
    try {
      for (const p of [...this.queue]) await this.cancel(p.request.request_id);
      if (this.active) await this.interrupt(this.active, "cancelled");
      while (this.active)
        await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.failing) await this.failing;
      if (!failed && this.state !== "failed" && !this.recordFailed) {
        await this.control({ ...this.base(), type: "collect" });
        await this.control({ ...this.base(), type: "shutdown" });
      }
    } catch (e) {
      cleanup = String(e);
    } finally {
      try {
        await this.transport.stop();
      } catch (e) {
        cleanup = String(e);
      }
      this.state = "closed";
      this.closeResult = {
        status: this.status,
        ...(cleanup ? { cleanup_error: cleanup } : {}),
        elapsed_ms: performance.now() - begin,
        wall_time_ms: performance.now() - this.created,
      };
      try {
        await this.emit("close", this.closeResult);
      } catch (e) {
        this.closeResult.cleanup_error = String(e);
        this.closeResult.status = "record_failure";
      }
    }
    if (this.closeResult.cleanup_error)
      throw new Error(this.closeResult.cleanup_error);
  }
}
