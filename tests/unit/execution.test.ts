import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionTransport, stageInputs } from "../../src/execution/docker";
import {
  type BridgeMessage,
  DEFAULT_LIMITS,
  type HostRequest,
  parseBridgeMessage,
  type SessionConfig,
  validateConfig,
} from "../../src/execution/protocol";
import { DockerSession } from "../../src/execution/session";

const config = (): SessionConfig => ({
  run_id: "unit",
  image: "test",
  input_root: "/tmp",
  inputs: [],
  staging_root: "/tmp",
  seed: 42,
  limits: {
    ...DEFAULT_LIMITS,
    cell_timeout_ms: 100,
    interrupt_grace_ms: 40,
    task_timeout_ms: 5000,
    startup_timeout_ms: 100,
  },
});
class FakeTransport implements SessionTransport {
  containerName = "fake";
  callback!: (message: BridgeMessage) => Promise<void>;
  failed!: (error: Error) => void;
  requests: HostRequest[] = [];
  stops = 0;
  ignoreInterrupt = false;
  autoFinish = true;
  onExecute?: (request: Extract<HostRequest, { type: "execute" }>) => void;
  async start(
    _config: SessionConfig,
    _session: string,
    onMessage: (message: BridgeMessage) => Promise<void>,
    onFailure: (error: Error) => void,
  ) {
    this.callback = onMessage;
    this.failed = onFailure;
    return {
      image_id: "sha256:test",
      image_digest: [],
      container_platform: "linux/arm64",
      docker_version: "test",
      inputs: [],
      container_name: this.containerName,
    };
  }
  async send(request: HostRequest) {
    this.requests.push(request);
    switch (request.type) {
      case "init":
        await this.callback({
          ...request,
          type: "ready",
          kernel_available: true,
          dependencies: { python: "3.12" },
        });
        break;
      case "execute":
        this.onExecute?.(request);
        if (this.autoFinish)
          setTimeout(() => {
            void this.finish(request);
          }, 5);
        break;
      case "interrupt":
        if (!this.ignoreInterrupt) {
          await this.callback({
            ...request,
            type: "control",
            operation: "interrupt",
            kernel_epoch: 1,
            kernel_available: true,
          });
          const active = this.requests.find(
            (r) => r.request_id === request.target_request_id,
          );
          if (active?.type === "execute") await this.finish(active, "error");
        }
        break;
      case "restart":
      case "collect":
      case "shutdown":
        await this.callback({
          ...request,
          type: "control",
          operation: request.type,
          kernel_epoch:
            request.type === "restart" ? request.kernel_epoch : this.epoch,
          kernel_available: true,
          files_preserved: true,
        });
        if (request.type === "restart") this.epoch = request.kernel_epoch;
    }
  }
  epoch = 1;
  async finish(
    request: Extract<HostRequest, { type: "execute" }>,
    status: "ok" | "error" = "ok",
  ) {
    await this.callback({
      ...request,
      type: "result",
      status,
      kernel_available: true,
      elapsed_ms: 5,
      persistence_complete: true,
    });
  }
  async stop() {
    this.stops++;
  }
}
function setup(c = config(), transport = new FakeTransport()) {
  return DockerSession.create(c, undefined, transport).then((session) => ({
    session,
    transport,
  }));
}
describe("execution protocol", () => {
  test("rejects invalid config and identities", () => {
    for (const x of [
      {},
      { ...config(), run_id: ".." },
      { ...config(), limits: { ...DEFAULT_LIMITS, memory_bytes: 0 } },
      { ...config(), seed: "42" },
    ])
      expect(() => validateConfig(x)).toThrow();
  });
  test("rejects invalid, oversized and mismatched bridge responses", () => {
    const valid = {
      protocol_version: 1,
      request_id: "r",
      session_id: "s",
      type: "ready",
      kernel_epoch: 1,
      kernel_available: true,
      dependencies: { python: "3" },
    };
    for (const x of [
      { ...valid, protocol_version: 2 },
      { ...valid, session_id: "other" },
      { ...valid, kernel_available: "true" },
      { ...valid, type: "result" },
    ])
      expect(() => parseBridgeMessage(JSON.stringify(x), 1000, "s")).toThrow();
    expect(() => parseBridgeMessage(JSON.stringify(valid), 5, "s")).toThrow();
    expect(() => parseBridgeMessage("bad", 1000, "s")).toThrow();
  });
  test("stages only explicit files, refusing traversal and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "statigent-input-test-"));
    await mkdir(join(root, "input"));
    await writeFile(join(root, "input", "good.csv"), "x\n1\n");
    await symlink(
      join(root, "input", "good.csv"),
      join(root, "input", "link.csv"),
    );
    const c = {
      ...config(),
      input_root: join(root, "input"),
      staging_root: join(root, "stage"),
      inputs: ["good.csv"],
    };
    expect((await stageInputs(c, "valid")).inputs[0]?.path).toBe("good.csv");
    for (const path of ["../good.csv", "link.csv", "/etc/passwd"]) {
      await expect(
        stageInputs({ ...c, inputs: [path] }, "invalid"),
      ).rejects.toThrow();
    }
  });
});
describe("session scheduling and host deadlines", () => {
  test("serializes FIFO, rejects duplicate IDs and queue overflow", async () => {
    const c = config();
    c.limits.queue_capacity = 1;
    const { session, transport } = await setup(c);
    transport.autoFinish = false;
    const a = session.execute("a", { requestId: "a" });
    const b = session.execute("b", { requestId: "b" });
    await expect(session.execute("again", { requestId: "a" })).rejects.toThrow(
      "duplicate",
    );
    await expect(session.execute("c")).rejects.toThrow("queue full");
    await Bun.sleep(1);
    const ar = transport.requests.find((r) => r.type === "execute");
    expect(ar?.type).toBe("execute");
    if (ar?.type !== "execute") throw Error();
    await transport.finish(ar);
    expect((await a).execution_seq).toBe(1);
    await Bun.sleep(1);
    const br = transport.requests.filter((r) => r.type === "execute")[1];
    if (br?.type !== "execute") throw Error();
    await transport.finish(br);
    expect((await b).execution_seq).toBe(2);
    await session.close();
  });
  test("queued cancellation has no execution sequence or code side effects", async () => {
    const { session, transport } = await setup();
    transport.autoFinish = false;
    const a = session.execute("long", { requestId: "a" });
    const b = session.execute("never", { requestId: "b" });
    await session.cancel("b");
    const cancelled = await b;
    expect(cancelled.started).toBe(false);
    expect(cancelled.execution_seq).toBeUndefined();
    await session.cancel("a");
    expect((await a).status).toBe("cancelled");
    expect(transport.requests.filter((r) => r.type === "execute")).toHaveLength(
      1,
    );
    await session.close();
  });
  test("host deadline interrupts and permits next cell only after terminal", async () => {
    const { session, transport } = await setup();
    transport.autoFinish = false;
    const result = await session.execute("loop");
    expect(result.status).toBe("timed_out");
    expect(result.kernel_available).toBe(true);
    expect(result.partial_state_possible).toBe(true);
    expect(session.state).toBe("ready");
    await session.close();
  });
  test("unresponsive interrupt invalidates session and never dispatches queued code", async () => {
    const { session, transport } = await setup();
    transport.autoFinish = false;
    transport.ignoreInterrupt = true;
    const a = session.execute("loop");
    const b = session.execute("never");
    expect((await a).kernel_available).toBe(false);
    expect((await b).started).toBe(false);
    expect(transport.requests.filter((r) => r.type === "execute")).toHaveLength(
      1,
    );
    expect(transport.stops).toBeGreaterThan(0);
    await session.close();
  });
  test("lost connection produces unknown failure with no automatic retry", async () => {
    const { session, transport } = await setup();
    transport.autoFinish = false;
    const result = session.execute("side_effect");
    await Bun.sleep(1);
    transport.failed(new Error("connection lost"));
    expect((await result).status).toBe("kernel_lost");
    expect(transport.requests.filter((r) => r.type === "execute")).toHaveLength(
      1,
    );
    await session.close();
  });
  test("record failure prevents dispatch", async () => {
    const transport = new FakeTransport();
    const session = await DockerSession.create(
      config(),
      {
        async onEvent(event) {
          if (event.type === "dispatch") throw Error("disk full");
        },
      },
      transport,
    );
    const result = await session.execute("never");
    expect(result.status).not.toBe("ok");
    expect(transport.requests.filter((r) => r.type === "execute")).toHaveLength(
      0,
    );
    await expect(session.close()).rejects.toThrow("record persistence");
  });
  test("restart creates new epoch and close is idempotent", async () => {
    const { session } = await setup();
    await session.execute("x=1");
    const restarted = await session.restart();
    expect(restarted.kernel_epoch).toBe(2);
    expect((await session.execute("x")).kernel_epoch).toBe(2);
    await session.close();
    await session.close();
    expect(session.state).toBe("closed");
  });
  test("task timeout stops active and cancels pending", async () => {
    const c = config();
    c.limits.task_timeout_ms = 30;
    c.limits.cell_timeout_ms = 1000;
    const { session, transport } = await setup(c);
    transport.autoFinish = false;
    const a = session.execute("long");
    const b = session.execute("never");
    expect((await a).status).toBe("timed_out");
    expect((await b).started).toBe(false);
    await session.close();
    expect(session.closeResult?.status).toBe("task_timeout");
  });
});

describe("dispatch and shutdown races", () => {
  test("cancelling while dispatch is being persisted never executes code", async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    let entered!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = await DockerSession.create(
      config(),
      {
        async onEvent(event) {
          if (event.type === "dispatch") {
            entered();
            await gate;
          }
        },
      },
      transport,
    );
    const result = session.execute("never", { requestId: "pending-write" });
    await seen;
    await session.cancel("pending-write");
    release();
    const cancelled = await result;
    expect(cancelled.started).toBe(false);
    expect(cancelled.execution_seq).toBeUndefined();
    expect(transport.requests.filter((r) => r.type === "execute")).toHaveLength(
      0,
    );
    expect((await session.execute("now")).execution_seq).toBe(1);
    await session.close();
  });

  test("restart cancels the old queued epoch and preserves dispatch ordering", async () => {
    const transport = new FakeTransport();
    transport.autoFinish = false;
    const { session } = await setup(config(), transport);
    const a = session.execute("active");
    const b = session.execute("old-queue");
    await Bun.sleep(2);
    const restarted = session.restart();
    expect((await a).status).toBe("cancelled");
    expect((await b).started).toBe(false);
    expect((await restarted).kernel_epoch).toBe(2);
    expect(transport.requests.filter((r) => r.type === "execute")).toHaveLength(
      1,
    );
    await session.close();
  });

  test("failure while cancelling queued work still settles all promises and stops", async () => {
    const transport = new FakeTransport();
    transport.autoFinish = false;
    const session = await DockerSession.create(
      config(),
      {
        async onEvent(event) {
          if (event.type === "finish") throw new Error("record storage lost");
        },
      },
      transport,
    );
    const a = session.execute("active", { requestId: "a" });
    const b = session.execute("queued", { requestId: "b" });
    await Bun.sleep(2);
    await session.cancel("b");
    expect((await a).status).not.toBe("ok");
    expect((await b).started).toBe(false);
    expect(transport.stops).toBeGreaterThan(0);
    await expect(session.close()).rejects.toThrow();
  });

  test("startup failure cleans resources and never executes", async () => {
    class FailedStart extends FakeTransport {
      override async start(
        ..._args: Parameters<FakeTransport["start"]>
      ): Promise<Awaited<ReturnType<FakeTransport["start"]>>> {
        throw new Error("image missing");
      }
    }
    const transport = new FailedStart();
    await expect(
      DockerSession.create(config(), undefined, transport),
    ).rejects.toThrow("image missing");
    expect(transport.stops).toBeGreaterThan(0);
    expect(transport.requests).toHaveLength(0);
  });
});

test("terminal persistence racing transport failure records one finish", async () => {
  const transport = new FakeTransport();
  transport.autoFinish = false;
  let release!: () => void;
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let terminals = 0;
  const session = await DockerSession.create(
    config(),
    {
      async onEvent(event) {
        if (event.type === "finish") {
          terminals++;
          entered();
          await gate;
        }
      },
    },
    transport,
  );
  const result = session.execute("done");
  await Bun.sleep(2);
  const request = transport.requests.find((r) => r.type === "execute");
  if (request?.type !== "execute") throw new Error("missing execution");
  const receiving = transport.finish(request);
  await seen;
  transport.failed(new Error("container exited during final persistence"));
  release();
  await receiving;
  await result;
  await session.close();
  expect(terminals).toBe(1);
});
