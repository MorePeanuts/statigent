import { expect, test } from "bun:test";
import { ScriptSession } from "../../src/execution/script-session";
import { FakeScriptTransport, scriptConfig } from "../helpers/script";

test("script FIFO, identities, duplicate requests and queued cancellation", async () => {
  const transport = new FakeScriptTransport();
  transport.autoFinish = false;
  const session = await ScriptSession.create(
    scriptConfig(),
    undefined,
    transport,
  );
  const a = session.execute("a", { requestId: "a" });
  const b = session.execute("b", { requestId: "b" });
  await expect(
    session.execute("duplicate", { requestId: "a" }),
  ).rejects.toThrow("Duplicate");
  await session.cancel("b");
  expect((await b).execution_seq).toBeUndefined();
  await Bun.sleep(2);
  const request = transport.requests.find((r) => r.type === "execute");
  if (request?.type !== "execute") throw Error();
  await transport.finish(request);
  expect((await a).execution_seq).toBe(1);
  transport.autoFinish = true;
  const next = await session.execute("new");
  expect(next.process?.instance_id).not.toBe((await a).process?.instance_id);
  expect(next.execution_seq).toBe(2);
  expect(next).not.toHaveProperty("kernel_epoch");
  await session.close();
});
test("script timeout and unavailable cleanup do not dispatch queued code", async () => {
  for (const ignore of [false, true]) {
    const transport = new FakeScriptTransport();
    transport.autoFinish = false;
    transport.ignoreInterrupt = ignore;
    const session = await ScriptSession.create(
      scriptConfig(),
      undefined,
      transport,
    );
    const a = session.execute("loop");
    const b = session.execute("queued");
    expect((await a).status).toBe("timed_out");
    if (ignore) {
      expect((await a).session_available).toBe(false);
      expect((await b).started).toBe(false);
      expect(
        transport.requests.filter((x) => x.type === "execute"),
      ).toHaveLength(1);
    } else {
      expect((await a).session_available).toBe(true);
      expect((await b).status).toBe("timed_out");
    }
    await session.close();
  }
});
test("persistence failure prevents script dispatch", async () => {
  const transport = new FakeScriptTransport();
  const session = await ScriptSession.create(
    scriptConfig(),
    {
      async onEvent(e) {
        if (e.type === "dispatch") throw Error("disk full");
      },
    },
    transport,
  );
  expect((await session.execute("never")).started).toBe(false);
  expect(transport.requests.filter((x) => x.type === "execute")).toHaveLength(
    0,
  );
  await expect(session.close()).rejects.toThrow("record persistence failed");
});
test("cancelling during journal write lets next script proceed", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const seen = new Promise<void>((r) => {
    entered = r;
  });
  const transport = new FakeScriptTransport();
  const session = await ScriptSession.create(
    scriptConfig(),
    {
      async onEvent(e) {
        if (e.type === "dispatch" && e.request_id === "a") {
          entered();
          await gate;
        }
      },
    },
    transport,
  );
  const a = session.execute("never", { requestId: "a" });
  await seen;
  const b = session.execute("next");
  await session.cancel("a");
  release();
  expect((await a).started).toBe(false);
  expect((await b).execution_seq).toBe(1);
  await session.close();
});
test("late script output invalidates the session", async () => {
  const transport = new FakeScriptTransport();
  const session = await ScriptSession.create(
    scriptConfig(),
    undefined,
    transport,
  );
  await session.execute("ok");
  const r = transport.requests.find((x) => x.type === "execute");
  if (r?.type !== "execute") throw Error();
  await transport.finish(r);
  expect(transport.stops).toBeGreaterThan(0);
  await expect(session.execute("never")).rejects.toThrow();
  await session.close();
});
