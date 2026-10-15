import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineExecution } from "../../src/baselines/execution";
import { repositoryRoot } from "../../src/baselines/source";
import { runTrustedWorker, workerViewSchema } from "../../src/baselines/worker";
import { command } from "../../src/evaluation/process";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";

test("worker failure, cancellation and deadline terminate only owned actual containers", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-lifecycle-")),
  );
  await mkdir(join(root, "input"));
  const make = (name: string) =>
    baselineExecution({
      config: {
        run_id: name,
        backend: "persistent-kernel",
        image: "statigent-runtime:baselines-cpu-v1",
        input_root: join(root, "input"),
        inputs: [],
        staging_root: join(root, name, "staging"),
        seed: 7,
        limits: {
          ...DEFAULT_LIMITS,
          memory_bytes: 2 * 1024 ** 3,
          task_timeout_ms: 90000,
        },
      },
      artifactDirectory: join(root, name, "artifacts"),
      event: async () => {},
    });
  const survivor = await make("survivor");
  try {
    await survivor.execute(
      "x = 42",
      "initialize",
      new AbortController().signal,
    );
    for (const goal of [
      "exit-during-execution",
      "cancel-during-execution",
      "timeout-during-execution",
    ]) {
      const execution = await make(goal),
        controller = new AbortController(),
        events: string[] = [];
      let cancel: ReturnType<typeof setTimeout> | undefined;
      try {
        const run = runTrustedWorker(
          {
            directory: join(root, `${goal}-worker`),
            timeout_ms: goal === "timeout-during-execution" ? 500 : 15000,
            signal: controller.signal,
            view: workerViewSchema.parse({
              protocol_version: 1,
              run_id: goal,
              method: "autogen",
              goal,
              constraints: [],
              files: [],
              output: { kind: "text", instructions: "test" },
              seed: 7,
              options: {
                schema_version: 1,
                method: "autogen",
                image: "fixture",
              },
            }),
            recorder: {
              event: async (type) => {
                events.push(type);
              },
            },
            handle: async (request, signal) => {
              if (request.type !== "execution.execute")
                throw new Error("Expected execution");
              if (goal === "cancel-during-execution")
                cancel = setTimeout(() => controller.abort(), 300);
              return {
                ...(await execution.execute(
                  request.code,
                  request.request_id,
                  signal,
                )),
              };
            },
            stopExecution: () => execution.close(),
          },
          {
            project: repositoryRoot,
            entry: join(repositoryRoot, "tests/fixtures/baseline_worker.py"),
          },
        );
        await expect(run).rejects.toThrow();
        expect(events).toContain("worker_failed");
        expect(execution.session.closeResult?.cleanup_error).toBeUndefined();
        await expect(
          command(["docker", "inspect", execution.session.containerName]),
        ).rejects.toThrow();
        const stillAlive = await survivor.execute(
          "print(x)",
          goal,
          new AbortController().signal,
        );
        expect(stillAlive.status).toBe("ok");
        expect(stillAlive.preview).toContain("42");
      } finally {
        clearTimeout(cancel);
        await execution.close();
      }
    }
  } finally {
    await survivor.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
