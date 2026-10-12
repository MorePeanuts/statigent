import { randomUUID } from "node:crypto";
import {
  DockerTransport,
  type SessionTransport,
  safeRelativePath,
  type TransportMetadata,
} from "./docker";
import {
  type ArtifactRef,
  type BridgeMessage,
  type ExecutionResult,
  type HostRequest,
  identifier,
  type NotebookOutput,
  PROTOCOL_VERSION,
  ProtocolError,
  type RuntimeEvent,
  type SessionConfig,
  type SessionObserver,
  type SessionState,
  type TerminalStatus,
  validateConfig,
} from "./protocol";

interface Pending {
  settling?: Promise<void>;
  request_id: string;
  cell_id: string;
  code: string;
  received: number;
  started?: number;
  execution_seq?: number;
  epoch: number;
  resolve: (result: ExecutionResult) => void;
  preview: string;
  preview_truncated: boolean;
  artifacts: ArtifactRef[];
  persistence_complete: boolean;
  reason?: TerminalStatus;
  timer?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
}
interface Waiter {
  resolve: (value: BridgeMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  operation: string;
}
export class DockerSession {
  readonly runId: string;
  readonly sessionId: string;
  state: SessionState = "starting";
  kernelEpoch = 1;
  metadata?: TransportMetadata;
  closeResult?: {
    status: string;
    cleanup_error?: string;
    elapsed_ms: number;
    wall_time_ms: number;
  };
  private readonly config: SessionConfig;
  private readonly observer?: SessionObserver;
  private readonly transport: SessionTransport;
  private readonly created = performance.now();
  private queue: Pending[] = [];
  private active?: Pending;
  private ids = new Set<string>();
  private history = new Map<
    string,
    { cell_id: string; kernel_epoch: number; execution_seq: number }
  >();
  private sequence = 0;
  private waiters = new Map<string, Waiter>();
  private events: Promise<void> = Promise.resolve();
  private taskTimer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private failing?: Promise<void>;
  private outputBytes = 0;
  private artifactBytes = 0;
  private taskStatus = "ok";
  private recordFailed = false;
  private constructor(
    config: SessionConfig,
    observer?: SessionObserver,
    transport: SessionTransport = new DockerTransport(),
  ) {
    this.config = validateConfig(config);
    this.runId = config.run_id;
    this.sessionId = config.session_id ?? randomUUID();
    this.observer = observer;
    this.transport = transport;
  }
  get containerName() {
    return this.transport.containerName;
  }
  static async create(
    config: SessionConfig,
    observer?: SessionObserver,
    transport?: SessionTransport,
  ): Promise<DockerSession> {
    const session = new DockerSession(config, observer, transport);
    try {
      await session.start();
      return session;
    } catch (e) {
      await session.fail(
        e instanceof Error ? e : new Error(String(e)),
        "kernel_lost",
      );
      await session.close();
      throw e;
    }
  }
  private async emit(type: string, detail: Record<string, unknown> = {}) {
    if (this.recordFailed)
      throw new Error("record persistence previously failed");
    try {
      await this.observer?.onEvent({
        type,
        at: new Date().toISOString(),
        run_id: this.runId,
        session_id: this.sessionId,
        ...detail,
      } satisfies RuntimeEvent);
    } catch (e) {
      this.recordFailed = true;
      throw new Error(`record persistence failed: ${e}`);
    }
  }
  private base(requestId: string = randomUUID()) {
    return {
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      session_id: this.sessionId,
    };
  }
  private async start() {
    await this.emit("session_start", { config: this.config });
    this.taskTimer = setTimeout(() => {
      this.taskStatus = "task_timeout";
      void this.close().catch((error) => {
        // closeResult retains cleanup failure even when the recorder itself is unavailable.
        if (!this.recordFailed)
          void this.emit("failure", {
            message: String(error),
            status: "cleanup_error",
          }).catch((recordError) => {
            if (this.closeResult)
              this.closeResult.cleanup_error = String(recordError);
          });
      });
    }, this.config.limits.task_timeout_ms);
    const deadline = performance.now() + this.config.limits.startup_timeout_ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.metadata = await Promise.race([
        this.transport.start(
          this.config,
          this.sessionId,
          (message) => {
            this.events = this.events
              .then(() => this.receive(message))
              .catch((e) =>
                this.fail(
                  e instanceof Error ? e : new Error(String(e)),
                  e instanceof ProtocolError ? "protocol_error" : "kernel_lost",
                ),
              );
            return this.events;
          },
          (error) => {
            void this.fail(
              error,
              error instanceof ProtocolError ? "protocol_error" : "kernel_lost",
            );
          },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("startup deadline exceeded")),
            this.config.limits.startup_timeout_ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.state !== "starting")
      throw new Error("session stopped during startup");
    const response = await this.control(
      {
        ...this.base(),
        type: "init",
        kernel_epoch: 1,
        seed: this.config.seed,
        limits: this.config.limits,
      },
      Math.max(1, deadline - performance.now()),
    );
    if (response.type !== "ready" || !response.kernel_available)
      throw new ProtocolError("kernel did not become ready");
    this.metadata.dependencies = response.dependencies;
    await this.emit("ready", {
      metadata: this.metadata,
      kernel_epoch: this.kernelEpoch,
    });
    this.state = "ready";
  }
  execute(
    code: string,
    options: { requestId?: string } = {},
  ): Promise<ExecutionResult> {
    try {
      const requestId = options.requestId ?? randomUUID();
      identifier(requestId, "request_id");
      if (
        typeof code !== "string" ||
        Buffer.byteLength(code) > this.config.limits.max_code_bytes
      )
        throw new ProtocolError("invalid or oversized code");
      if (!["ready", "busy"].includes(this.state))
        throw new Error(`session cannot execute while ${this.state}`);
      if (this.ids.has(requestId))
        throw new ProtocolError("duplicate request_id");
      if (this.active && this.queue.length >= this.config.limits.queue_capacity)
        throw new Error("execution queue full");
      this.ids.add(requestId);
      return new Promise((resolve) => {
        this.queue.push({
          request_id: requestId,
          cell_id: randomUUID(),
          code,
          received: performance.now(),
          epoch: this.kernelEpoch,
          resolve,
          preview: "",
          preview_truncated: false,
          artifacts: [],
          persistence_complete: true,
        });
        void this.pump();
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }
  private async pump() {
    if (this.active || this.state !== "ready") return;
    const p = this.queue.shift();
    if (!p) return;
    this.active = p;
    this.state = "busy";
    p.execution_seq = this.sequence + 1;
    const request: HostRequest = {
      ...this.base(p.request_id),
      type: "execute",
      cell_id: p.cell_id,
      kernel_epoch: p.epoch,
      execution_seq: p.execution_seq,
      code: p.code,
    };
    try {
      await this.emit("dispatch", {
        request,
        code: p.code,
        request_id: p.request_id,
        cell_id: p.cell_id,
        kernel_epoch: p.epoch,
        execution_seq: p.execution_seq,
        waiting_ms: performance.now() - p.received,
      });
      if (this.active !== p) return;
      if (p.reason || this.state !== "busy") {
        p.execution_seq = undefined;
        await this.finish(p, p.reason ?? "cancelled", !this.recordFailed);
        if ((this.state as SessionState) === "ready") void this.pump();
        return;
      }
      p.started = performance.now();
      this.sequence++;
      this.history.set(p.request_id, {
        cell_id: p.cell_id,
        kernel_epoch: p.epoch,
        execution_seq: request.execution_seq,
      });
      p.timer = setTimeout(() => {
        void this.interrupt(p, "timed_out");
      }, this.config.limits.cell_timeout_ms);
      await this.transport.send(request);
    } catch (e) {
      if (p.started === undefined) p.execution_seq = undefined;
      await this.fail(
        e instanceof Error ? e : new Error(String(e)),
        "protocol_error",
      );
    }
  }
  private async control(
    request: HostRequest,
    timeout = this.config.limits.startup_timeout_ms,
  ): Promise<BridgeMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(request.request_id);
        reject(new Error(`${request.type} deadline exceeded`));
      }, timeout);
      this.waiters.set(request.request_id, {
        resolve,
        reject,
        timer,
        operation: request.type,
      });
      void this.transport.send(request).catch((e) => {
        clearTimeout(timer);
        this.waiters.delete(request.request_id);
        reject(e);
      });
    });
  }
  private async receive(message: BridgeMessage) {
    if (this.state === "failed" || this.state === "closed") return;
    if (message.session_id !== this.sessionId || message.protocol_version !== 1)
      throw new ProtocolError("identity mismatch");
    const waiter = this.waiters.get(message.request_id);
    if (message.type === "ready" || message.type === "control") {
      if (!waiter) throw new ProtocolError("unsolicited control response");
      if (
        (message.type === "ready" && waiter.operation !== "init") ||
        (message.type === "control" &&
          message.operation !== waiter.operation) ||
        message.kernel_epoch !== this.kernelEpoch
      )
        throw new ProtocolError("control identity mismatch");
      if (
        message.type === "control" &&
        (message.operation === "collect" || message.operation === "shutdown")
      ) {
        if (message.limit_exceeded) this.taskStatus = "output_limit_exceeded";
        else if (
          message.persistence_complete === false &&
          this.taskStatus === "ok"
        )
          this.taskStatus = "incomplete_artifacts";
      }
      clearTimeout(waiter.timer);
      this.waiters.delete(message.request_id);
      waiter.resolve(message);
      return;
    }
    if (message.type === "diagnostic") {
      await this.emit("diagnostic", { message });
      return;
    }
    if (message.type === "artifact" && waiter?.operation === "collect") {
      await this.artifact(message);
      return;
    }
    const expected = this.history.get(message.request_id);
    if (
      !expected ||
      message.cell_id !== expected.cell_id ||
      message.kernel_epoch !== expected.kernel_epoch ||
      message.execution_seq !== expected.execution_seq
    )
      throw new ProtocolError("cell identity mismatch");
    if (message.type === "output") {
      const bytes = Buffer.byteLength(JSON.stringify(message.output));
      this.outputBytes += bytes;
      if (this.outputBytes > this.config.limits.max_output_bytes) {
        if (this.active?.request_id === message.request_id) {
          this.active.persistence_complete = false;
          void this.interrupt(this.active, "output_limit_exceeded");
        } else {
          this.taskStatus = "output_limit_exceeded";
          await this.emit("diagnostic", {
            message: {
              type: "diagnostic",
              message: "late output exceeds persistence limit",
              request_id: message.request_id,
              cell_id: message.cell_id,
              kernel_epoch: message.kernel_epoch,
              persistence_complete: false,
            },
          });
        }
        return;
      }
      await this.emit("output", { message });
      if (message.output.output_type === "stream") {
        if (message.output.text.length > this.config.limits.preview_chars)
          await this.outputArtifact(message, "text/plain", message.output.text);
      } else if ("data" in message.output) {
        for (const [mime, value] of Object.entries(message.output.data)) {
          if (
            mime !== "text/plain" ||
            value.length > this.config.limits.preview_chars
          )
            await this.outputArtifact(message, mime, value);
        }
      }
      if (this.active?.request_id === message.request_id) {
        const p = this.active;
        const text = preview(message.output);
        const room = this.config.limits.preview_chars - p.preview.length;
        p.preview += text.slice(0, room);
        if (text.length > room) p.preview_truncated = true;
      }
      return;
    }
    if (message.type === "artifact") {
      await this.artifact(message);
      return;
    }
    if (message.type !== "result")
      throw new ProtocolError("unexpected bridge message");
    const p = this.active;
    if (!p || p.request_id !== message.request_id)
      throw new ProtocolError("unexpected or duplicate terminal result");
    if (!message.kernel_available) {
      await this.finish(
        p,
        message.status === "ok" ? "kernel_lost" : message.status,
        false,
        {
          error: message.error,
          elapsed_ms: message.elapsed_ms,
          persistence_complete: message.persistence_complete,
        },
      );
      await this.fail(
        new Error("kernel unavailable after execution"),
        "kernel_lost",
      );
      return;
    }
    await this.finish(p, p.reason ?? message.status, true, {
      error: message.error,
      elapsed_ms: message.elapsed_ms,
      persistence_complete: message.persistence_complete,
    });
    if (this.state === "ready") void this.pump();
  }
  private outputIndex = 0;
  private async outputArtifact(
    message: Extract<BridgeMessage, { type: "output" }>,
    mime: string,
    value: string,
  ) {
    const ext =
      mime === "image/png" ? "png" : mime === "text/html" ? "html" : "txt";
    await this.artifact({
      ...this.base(message.request_id),
      type: "artifact",
      cell_id: message.cell_id,
      kernel_epoch: message.kernel_epoch,
      execution_seq: message.execution_seq,
      path: `outputs/${message.cell_id}/${++this.outputIndex}.${ext}`,
      mime_type: mime,
      data_base64:
        mime === "image/png" ? value : Buffer.from(value).toString("base64"),
    });
  }
  private async artifact(
    message: Extract<BridgeMessage, { type: "artifact" }>,
  ) {
    const size = Buffer.byteLength(message.data_base64, "base64");
    const p =
      this.active?.request_id === message.request_id ? this.active : undefined;
    if (
      !safeRelativePath(message.path) ||
      ![
        "image/png",
        "text/plain",
        "text/csv",
        "text/html",
        "application/json",
        "application/octet-stream",
      ].includes(message.mime_type)
    ) {
      if (p) p.persistence_complete = false;
      else this.taskStatus = "incomplete_artifacts";
      await this.emit("diagnostic", {
        message: "invalid artifact path or MIME",
        path: message.path,
      });
      return;
    }
    this.artifactBytes += size + Buffer.byteLength(message.path) + 128;
    if (
      size > this.config.limits.max_artifact_bytes ||
      this.artifactBytes > this.config.limits.max_artifacts_bytes
    ) {
      if (p) {
        p.persistence_complete = false;
        void this.interrupt(p, "output_limit_exceeded");
      } else this.taskStatus = "output_limit_exceeded";
      await this.emit("diagnostic", {
        message: "artifact limit exceeded",
        path: message.path,
      });
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
    status: TerminalStatus,
    kernelAvailable: boolean,
    extra: Partial<ExecutionResult> = {},
  ): ExecutionResult {
    return {
      protocol_version: 1,
      request_id: p.request_id,
      session_id: this.sessionId,
      cell_id: p.cell_id,
      kernel_epoch: p.epoch,
      started: p.started !== undefined,
      ...(p.execution_seq !== undefined
        ? { execution_seq: p.execution_seq }
        : {}),
      status,
      elapsed_ms: p.started === undefined ? 0 : performance.now() - p.started,
      waiting_ms: (p.started ?? performance.now()) - p.received,
      kernel_available: kernelAvailable,
      persistence_complete: p.persistence_complete,
      preview: p.preview,
      preview_truncated: p.preview_truncated,
      artifacts: p.artifacts,
      partial_state_possible: p.started !== undefined && status !== "ok",
      ...extra,
    };
  }
  private finish(
    p: Pending,
    status: TerminalStatus,
    kernelAvailable: boolean,
    extra: Partial<ExecutionResult> = {},
  ): Promise<void> {
    if (p.settling) return p.settling;
    p.settling = this.finishInternal(p, status, kernelAvailable, extra).catch(
      (error) => {
        p.settling = undefined;
        throw error;
      },
    );
    return p.settling;
  }
  private async finishInternal(
    p: Pending,
    status: TerminalStatus,
    kernelAvailable: boolean,
    extra: Partial<ExecutionResult> = {},
  ) {
    clearTimeout(p.timer);
    clearTimeout(p.grace);
    const result = this.result(p, status, kernelAvailable, {
      ...extra,
      persistence_complete:
        p.persistence_complete && (extra.persistence_complete ?? true),
    });
    await this.emit("finish", { result });
    if (this.active === p) {
      this.active = undefined;
      if (
        kernelAvailable &&
        (this.state === "busy" || this.state === "interrupting")
      )
        this.state = "ready";
    }
    p.resolve(result);
  }
  async cancel(requestId: string) {
    const index = this.queue.findIndex((p) => p.request_id === requestId);
    if (index >= 0) {
      const p = this.queue.splice(index, 1)[0];
      if (p) {
        try {
          await this.finish(p, "cancelled", this.state !== "failed");
        } catch (error) {
          p.resolve(
            this.result(p, "cancelled", false, { diagnostic: String(error) }),
          );
          await this.fail(
            error instanceof Error ? error : new Error(String(error)),
            "kernel_lost",
          );
        }
      }
      return true;
    }
    if (this.active?.request_id === requestId) {
      await this.interrupt(this.active, "cancelled");
      return true;
    }
    return false;
  }
  private async interrupt(
    p: Pending,
    reason: "timed_out" | "cancelled" | "output_limit_exceeded",
  ) {
    if (this.active !== p || p.reason) return;
    p.reason = reason;
    if (p.started === undefined) return;
    clearTimeout(p.timer);
    if (this.state === "busy") this.state = "interrupting";
    try {
      await this.emit("interrupt", {
        request_id: p.request_id,
        cell_id: p.cell_id,
        kernel_epoch: p.epoch,
        reason,
      });
      p.grace = setTimeout(() => {
        void this.fail(
          new Error(`interrupt not confirmed within grace (${reason})`),
          reason,
        );
      }, this.config.limits.interrupt_grace_ms);
      void this.control(
        {
          ...this.base(),
          type: "interrupt",
          target_request_id: p.request_id,
          reason,
        },
        this.config.limits.interrupt_grace_ms,
      ).catch((e) => {
        if (this.active === p) void this.fail(e, reason);
      });
    } catch (e) {
      await this.fail(
        e instanceof Error ? e : new Error(String(e)),
        "kernel_lost",
      );
    }
  }
  async restart() {
    if (!["ready", "busy", "interrupting"].includes(this.state))
      throw new Error(`cannot restart while ${this.state}`);
    this.state = "restarting";
    await this.cancelQueue();
    if (this.recordFailed) {
      await this.fail(
        new Error("record persistence failed during restart"),
        "kernel_lost",
      );
      throw new Error("record persistence failed during restart");
    }
    if (this.active) {
      const p = this.active;
      await this.interrupt(p, "cancelled");
      await this.waitInactive();
      if ((this.state as SessionState) === "failed")
        throw new Error("restart failed: kernel lost");
    }
    this.kernelEpoch++;
    try {
      const reply = await this.control({
        ...this.base(),
        type: "restart",
        kernel_epoch: this.kernelEpoch,
      });
      if (reply.type !== "control" || !reply.kernel_available)
        throw new Error("restart did not restore a ready kernel");
      await this.emit("restart", {
        kernel_epoch: this.kernelEpoch,
        files_preserved: reply.files_preserved === true,
      });
      this.state = "ready";
      return {
        kernel_epoch: this.kernelEpoch,
        files_preserved: reply.files_preserved === true,
      };
    } catch (e) {
      await this.fail(
        e instanceof Error ? e : new Error(String(e)),
        "kernel_lost",
      );
      throw e;
    }
  }
  private async waitInactive() {
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  private async cancelQueue() {
    const pending = this.queue.splice(0);
    for (const p of pending) {
      try {
        await this.finish(p, "cancelled", false);
      } catch {
        p.resolve(
          this.result(p, "cancelled", false, {
            diagnostic: "record persistence failed",
          }),
        );
      }
    }
  }
  private async fail(error: Error, status: TerminalStatus): Promise<void> {
    if (this.failing) return this.failing;
    this.failing = (async () => {
      this.state = "failed";
      if (this.taskStatus !== "task_timeout") this.taskStatus = status;
      clearTimeout(this.taskTimer);
      for (const w of this.waiters.values()) {
        clearTimeout(w.timer);
        w.reject(error);
      }
      this.waiters.clear();
      const p = this.active;
      if (p) {
        clearTimeout(p.timer);
        clearTimeout(p.grace);
      }
      try {
        await this.transport.stop();
      } catch (cleanup) {
        this.closeResult = {
          status,
          cleanup_error: String(cleanup),
          elapsed_ms: 0,
          wall_time_ms: performance.now() - this.created,
        };
      }
      if (p && this.active === p) {
        const extra = {
          diagnostic: error.message,
          persistence_complete: false,
        };
        try {
          await this.finish(p, status, false, extra);
        } catch {
          this.active = undefined;
          p.resolve(this.result(p, status, false, extra));
        }
      }
      await this.cancelQueue();
      try {
        await this.emit("failure", { message: error.message, status });
      } catch {
        /* Failed recording forbids further work. */
      }
    })();
    return this.failing;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal();
    return this.closing;
  }
  private async closeInternal() {
    const begin = performance.now();
    clearTimeout(this.taskTimer);
    const failed = this.state === "failed";
    this.state = "closing";
    let cleanupError = this.closeResult?.cleanup_error;
    try {
      await this.cancelQueue();
      if (this.active) {
        await this.interrupt(
          this.active,
          this.taskStatus === "task_timeout" ? "timed_out" : "cancelled",
        );
        await this.waitInactive();
      }
      if (
        !failed &&
        !this.recordFailed &&
        (this.state as SessionState) !== "failed"
      ) {
        try {
          await this.control(
            { ...this.base(), type: "collect" },
            this.config.limits.interrupt_grace_ms,
          );
          await this.control(
            { ...this.base(), type: "shutdown" },
            this.config.limits.interrupt_grace_ms,
          );
        } catch (e) {
          cleanupError = String(e);
        }
      }
    } finally {
      try {
        await this.transport.stop();
      } catch (e) {
        cleanupError = String(e);
      }
      this.state = "closed";
      this.closeResult = {
        status: this.taskStatus,
        ...(cleanupError ? { cleanup_error: cleanupError } : {}),
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
function preview(output: NotebookOutput): string {
  switch (output.output_type) {
    case "stream":
      return output.text;
    case "error":
      return `${output.ename}: ${output.evalue}\n`;
    case "clear_output":
      return "";
    default:
      return output.data["text/plain"] ?? "";
  }
}
