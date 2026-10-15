import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineExecution } from "../../src/baselines/execution";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";

test("known FST replay clears container state and shares total execution budget", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-replay-")),
  );
  await mkdir(join(root, "input"));
  await writeFile(join(root, "input/data.csv"), "x\n1\n");
  const events: string[] = [];
  const execution = await baselineExecution({
    config: {
      run_id: "baseline-replay",
      backend: "persistent-kernel",
      image: "statigent-runtime:baselines-cpu-v1",
      input_root: join(root, "input"),
      inputs: ["data.csv"],
      staging_root: join(root, "stage"),
      seed: 7,
      limits: {
        ...DEFAULT_LIMITS,
        task_timeout_ms: 60000,
        cell_timeout_ms: 5000,
      },
    },
    artifactDirectory: join(root, "artifacts"),
    allowKnownReplay: true,
    maxExecutions: 3,
    event: async (type) => {
      events.push(type);
    },
  });
  const signal = new AbortController().signal;
  try {
    expect(
      (
        await execution.execute(
          "from pathlib import Path\nx = 1\nPath('old.txt').write_text('old')",
          "first",
          signal,
        )
      ).status,
    ).toBe("ok");
    const oldContainer = execution.session.containerName;
    expect(await execution.restart("post-filter", signal)).toEqual({
      kernel_epoch: 2,
    });
    expect(execution.session.containerName).not.toBe(oldContainer);
    await expect(execution.artifacts.read("old.txt")).rejects.toThrow();
    const replay = await execution.execute(
      "from pathlib import Path\nassert 'x' not in globals()\nassert not Path('old.txt').exists()\nassert Path('/input/data.csv').exists()\nx = 2",
      "replay",
      signal,
    );
    expect(replay.status).toBe("ok");
    await execution.restart("plan-rollback", signal);
    expect((await execution.execute("print(42)", "third", signal)).status).toBe(
      "ok",
    );
    await expect(
      execution.execute("print(99)", "extra", signal),
    ).rejects.toThrow("budget");
    expect(execution.usage()).toEqual({ executions: 3, kernel_epoch: 3 });
    expect(events.filter((x) => x === "replay_started")).toHaveLength(2);
    await execution.close();
    await expect(execution.restart("post-filter", signal)).rejects.toThrow();
  } finally {
    await execution.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

test("lost kernel and cancellation cannot authorize replay", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "baseline-lost-")));
  await mkdir(join(root, "input"));
  const execution = await baselineExecution({
    config: {
      run_id: "baseline-lost",
      backend: "persistent-kernel",
      image: "statigent-runtime:baselines-cpu-v1",
      input_root: join(root, "input"),
      inputs: [],
      staging_root: join(root, "stage"),
      seed: 7,
      limits: {
        ...DEFAULT_LIMITS,
        task_timeout_ms: 30000,
        cell_timeout_ms: 1500,
        interrupt_grace_ms: 1000,
      },
    },
    artifactDirectory: join(root, "artifacts"),
    allowKnownReplay: true,
    event: async () => {},
  });
  try {
    const result = await execution.execute(
      "import os\nos._exit(17)",
      "lost",
      new AbortController().signal,
    );
    expect(result.status).not.toBe("ok");
    await expect(
      execution.restart("post-filter", new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      execution.execute("print('wrong')", "late", new AbortController().signal),
    ).rejects.toThrow();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      execution.restart("plan-rollback", cancelled.signal),
    ).rejects.toThrow();
  } finally {
    await execution.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
