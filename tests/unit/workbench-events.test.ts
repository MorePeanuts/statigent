import { expect, test } from "bun:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type EventCursor,
  normalizeEvent,
  readNewEvents,
} from "../../src/workbench/events";
import { workerMain } from "../../src/workbench/worker";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";

const START: EventCursor = { offset: 0, seq: 0 };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function file(content = "") {
  const path = join(
    await mkdtemp(join(tmpdir(), "workbench-events-")),
    "events.jsonl",
  );
  await writeFile(path, content);
  return path;
}

test("an unfinished last line is held back until its newline arrives", async () => {
  const first = line({ type: "run_finished", status: "completed" });
  const second = line({ type: "agent_finish", status: "completed" });
  const path = await file(`${first}${second}{"type":"ready","kern`);
  const read = await readNewEvents(path, START);
  expect(read.events.map((e) => e.seq)).toEqual([1, 2]);
  expect(read.cursor).toEqual({
    offset: Buffer.byteLength(first + second),
    seq: 2,
  });
  // Nothing new is complete yet.
  expect((await readNewEvents(path, read.cursor)).events).toEqual([]);
  await appendFile(path, 'el_epoch":2}\n');
  const next = await readNewEvents(path, read.cursor);
  expect(next.events).toMatchObject([
    { seq: 3, type: "ready", kind: "session", data: { kernel_epoch: 2 } },
  ]);
});

test("resuming after a sequence number skips what the client already has", async () => {
  const path = await file(
    [1, 2, 3, 4].map((n) => line({ type: "close", status: "ok", n })).join(""),
  );
  const read = await readNewEvents(path, START, 2);
  expect(read.events.map((e) => e.seq)).toEqual([3, 4]);
  expect(read.cursor.seq).toBe(4);
});

test("a missing trace file reads as empty", async () => {
  expect(
    await readNewEvents(join(tmpdir(), "does-not-exist.jsonl"), START),
  ).toEqual({ events: [], cursor: START });
});

test("a single-agent run produced by the agent normalizes without roles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-events-run-"));
  const taskPath = join(directory, "task.json");
  const modelsPath = join(directory, "models.json");
  await writeFile(
    taskPath,
    JSON.stringify({
      ...task,
      execution: { ...task.execution, input_root: resolve("tests/fixtures") },
    }),
  );
  await writeFile(modelsPath, JSON.stringify([profile]));
  const runs = join(directory, "runs");
  await workerMain(
    [
      "--task",
      taskPath,
      "--models",
      modelsPath,
      "--model",
      profile.id,
      "--runs",
      runs,
      "--run-id",
      "single",
    ],
    new AbortController().signal,
    {
      client: new ScriptClient((body, i) =>
        i === 0
          ? reply([call("execute_python", { code: "x = 1\nprint(x)" })])
          : reply([finish(String(lastFeedback(body).cell_id))]),
      ),
      createSession: fakeRuntime().createSession,
    },
  );
  const { events } = await readNewEvents(
    join(runs, "single", "events.jsonl"),
    START,
  );
  expect(events.every((e) => e.role === null)).toBe(true);
  expect(events.filter((e) => e.kind === "generic")).toEqual([]);
  const dispatch = events.find((e) => e.type === "dispatch");
  expect(dispatch).toMatchObject({
    kind: "code",
    execution_id: "cell-1",
    data: { code: "x = 1\nprint(x)", execution_seq: 1 },
  });
  const response = events.find((e) => e.type === "model_response");
  expect(response?.refs.content?.artifact_id).toBeString();
  // Model text is never inlined into the view.
  expect(JSON.stringify(response)).not.toContain("test reasoning");
  expect(events.at(-1)).toMatchObject({
    type: "run_finished",
    kind: "finish",
    data: { status: "completed" },
  });
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
});

test("planner-executor events keep role and subtask identity", () => {
  const delegated = normalizeEvent(7, {
    type: "subtask_delegated",
    at: "2026-10-15T04:00:34.251Z",
    role: "planner",
    subtask_id: "sub-1",
    attempt_id: "a1",
    content_ref: {
      artifact_id: "c1",
      path: "artifacts/c1",
      mime_type: "application/json",
      size_bytes: 10,
      sha256: "x",
    },
  });
  expect(delegated).toMatchObject({
    kind: "delegation",
    role: "planner",
    subtask_id: "sub-1",
    refs: { content: { artifact_id: "c1", mime_type: "application/json" } },
  });
  const feedback = normalizeEvent(20, {
    type: "tool_validation",
    role: "executor",
    subtask_id: "sub-1",
    tool_id: "t1",
    request_id: "r1",
    cell_id: "cell-9",
    content_ref: { artifact_id: "f1" },
  });
  expect(feedback).toMatchObject({
    kind: "tool",
    execution_id: "cell-9",
    summary: "执行反馈已返回模型",
    refs: { feedback: { artifact_id: "f1" } },
  });
});

test("fresh-script executions are identified by execution ID", () => {
  const dispatch = normalizeEvent(1, {
    type: "dispatch",
    backend: "fresh-script",
    code: "print(1)",
    code_sha256: "h",
    request: {
      protocol_version: 2,
      backend: "fresh-script",
      type: "execute",
      request_id: "r1",
      session_id: "s1",
      execution_id: "exec-1",
      execution_seq: 1,
      code: "print(1)",
    },
  });
  expect(dispatch).toMatchObject({
    kind: "code",
    execution_id: "exec-1",
    data: { code: "print(1)", kernel_epoch: null },
  });
  const output = normalizeEvent(2, {
    type: "output",
    backend: "fresh-script",
    message: {
      request_id: "r1",
      execution_id: "exec-1",
      output_type: "stream",
      name: "stdout",
      text: "1\n",
    },
  });
  expect(output).toMatchObject({
    kind: "output",
    execution_id: "exec-1",
    data: { text: "1\n", name: "stdout" },
  });
  const result = normalizeEvent(3, {
    type: "finish",
    result: {
      protocol_version: 2,
      request_id: "r1",
      execution_id: "exec-1",
      execution_seq: 1,
      status: "error",
      preview: "Traceback",
      error: { ename: "ValueError", evalue: "bad", traceback: [] },
      artifacts: [{ artifact_id: "png1", mime_type: "image/png" }],
    },
  });
  expect(result).toMatchObject({
    kind: "result",
    summary: "执行结束：error",
    data: { status: "error", error: { ename: "ValueError", evalue: "bad" } },
    refs: { artifact_0: { artifact_id: "png1", mime_type: "image/png" } },
  });
});

test("unknown, malformed and non-object lines degrade instead of breaking the stream", async () => {
  const unknown = normalizeEvent(1, {
    type: "future_event",
    at: "2026-10-20T00:00:00Z",
    role: "planner",
    detail: "x",
    nested: { dropped: true },
  });
  expect(unknown).toMatchObject({
    kind: "generic",
    type: "future_event",
    role: "planner",
    data: { detail: "x" },
  });
  expect(unknown.data).not.toHaveProperty("nested");
  // A known type with an unexpected shape is shown generically, not rejected.
  expect(normalizeEvent(2, { type: "dispatch", request: 5 }).kind).toBe(
    "generic",
  );
  const path = await file(`not json\n[1,2]\n${line({ type: "close" })}`);
  const { events } = await readNewEvents(path, START);
  expect(events.map((e) => [e.seq, e.kind])).toEqual([
    [1, "diagnostic"],
    [2, "diagnostic"],
    [3, "diagnostic"],
  ]);
});

test("large code is clipped and multi-byte text survives read-chunk boundaries", async () => {
  const code = "数据".repeat(400_000); // ~2.4 MB of UTF-8, larger than one read chunk
  const path = await file(
    line({ type: "dispatch", request: { request_id: "r", code } }) +
      line({ type: "close" }),
  );
  const { events } = await readNewEvents(path, START);
  expect(events).toHaveLength(2);
  expect(events[0]?.data.code_truncated).toBe(true);
  expect(String(events[0]?.data.code)).toBe(code.slice(0, 64 * 1024));
});
