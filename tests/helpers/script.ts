import type { SessionConfig } from "../../src/execution/protocol";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";
import type {
  ScriptMessage,
  ScriptRequest,
  ScriptStatus,
} from "../../src/execution/script-protocol";
import type { ScriptTransport } from "../../src/execution/script-session";
export const scriptConfig = (): SessionConfig => ({
  backend: "fresh-script",
  run_id: "script-unit",
  image: "test",
  input_root: "/tmp",
  inputs: [],
  staging_root: "/tmp",
  seed: 42,
  limits: {
    ...DEFAULT_LIMITS,
    cell_timeout_ms: 100,
    interrupt_grace_ms: 40,
    startup_timeout_ms: 100,
    task_timeout_ms: 5000,
  },
});
export class FakeScriptTransport implements ScriptTransport {
  containerName = "fake";
  callback!: (message: ScriptMessage) => Promise<void>;
  failed!: (error: Error) => void;
  requests: ScriptRequest[] = [];
  stops = 0;
  autoFinish = true;
  ignoreInterrupt = false;
  async start(
    _c: SessionConfig,
    _s: string,
    callback: typeof this.callback,
    failed: typeof this.failed,
  ) {
    this.callback = callback;
    this.failed = failed;
    return {
      image_id: "sha256:test",
      image_digest: [],
      container_platform: "linux/arm64",
      docker_version: "test",
      inputs: [],
      container_name: this.containerName,
    };
  }
  async send(r: ScriptRequest) {
    this.requests.push(r);
    const base = {
      protocol_version: 2 as const,
      backend: "fresh-script" as const,
      request_id: r.request_id,
      session_id: r.session_id,
    };
    if (r.type === "init")
      await this.callback({
        ...base,
        type: "ready",
        session_available: true,
        initialization: "script-init-v1",
        dependencies: { python: "3.12" },
      });
    else if (r.type === "execute") {
      if (this.autoFinish) setTimeout(() => void this.finish(r), 2);
    } else if (r.type !== "interrupt" || !this.ignoreInterrupt) {
      await this.callback({
        ...base,
        type: "control",
        operation: r.type,
        session_available: r.type !== "shutdown",
        persistence_complete: true,
        limit_exceeded: false,
      });
      if (r.type === "interrupt") {
        const active = this.requests.find(
          (x) => x.request_id === r.target_request_id,
        );
        if (active?.type === "execute") await this.finish(active, r.reason);
      }
    }
  }
  async finish(
    r: Extract<ScriptRequest, { type: "execute" }>,
    status: ScriptStatus = "ok",
  ) {
    await this.callback({
      protocol_version: 2,
      backend: "fresh-script",
      request_id: r.request_id,
      session_id: r.session_id,
      type: "result",
      execution_id: r.execution_id,
      execution_seq: r.execution_seq,
      status,
      started: true,
      process: { instance_id: r.execution_id, pid: 40 + r.execution_seq },
      session_available: true,
      persistence_complete: true,
      elapsed_ms: 5,
      timing: {
        process_startup_ms: 1,
        execution_ms: 2,
        collection_ms: 1,
        cleanup_ms: 1,
      },
    });
  }
  async stop() {
    this.stops++;
  }
}
