import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "../../src/baselines/source";
import {
  runTrustedWorker,
  workerEnvironment,
  workerViewSchema,
} from "../../src/baselines/worker";

const view = {
  protocol_version: 1,
  run_id: "fixture",
  method: "autogen",
  goal: "task",
  constraints: [],
  files: ["train.csv"],
  output: { kind: "text", instructions: "answer" },
  seed: 7,
  options: { schema_version: 1, method: "autogen", image: "fixture" },
};
test("public worker view cannot override host commands or model addresses", () => {
  for (const key of ["command", "root", "base_url", "env", "private_inputs"])
    expect(() => workerViewSchema.parse({ ...view, [key]: "/host" })).toThrow();
  expect(() =>
    workerViewSchema.parse({ ...view, files: ["../private"] }),
  ).toThrow();
  const env = workerEnvironment("/task", {
    PATH: "/bin",
    OPENAI_API_KEY: "sentinel",
    CUSTOM_CONFIG: "/host/config",
  });
  expect(env.HOME).toBe("/task");
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.CUSTOM_CONFIG).toBeUndefined();
});
test("real trusted uv worker routes requests and records abnormal exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseline-worker-"));
  try {
    for (const goal of ["task", "crash"]) {
      const requests: string[] = [],
        events: string[] = [];
      let cleanups = 0;
      const run = runTrustedWorker(
        {
          view: workerViewSchema.parse({ ...view, goal }),
          directory: join(root, goal),
          timeout_ms: 5000,
          signal: new AbortController().signal,
          recorder: {
            event: async (type) => {
              events.push(type);
            },
          },
          handle: async (request) => {
            requests.push(request.type);
            return {};
          },
          stopExecution: async () => {
            cleanups++;
          },
        },
        {
          project: repositoryRoot,
          entry: join(repositoryRoot, "tests/fixtures/baseline_worker.py"),
        },
      );
      if (goal === "crash") {
        await expect(run).rejects.toThrow();
        expect(events).toContain("worker_failed");
        expect(requests).toEqual([]);
      } else {
        await run;
        expect(requests).toEqual(["execution.execute", "submission.finish"]);
        expect(events).toContain("worker_finished");
      }
      expect(cleanups).toBe(1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker startup failure is recorded and still cleans the execution session", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseline-startup-"));
  const events: string[] = [];
  let closed = false;
  try {
    await expect(
      runTrustedWorker({
        view: workerViewSchema.parse(view),
        directory: root,
        timeout_ms: 1000,
        signal: new AbortController().signal,
        recorder: {
          event: async (type) => {
            events.push(type);
          },
        },
        handle: async () => ({}),
        stopExecution: async () => {
          closed = true;
        },
      }),
    ).rejects.toThrow();
    expect(events).toEqual(["worker_failed"]);
    expect(closed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
