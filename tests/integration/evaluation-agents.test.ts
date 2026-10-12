import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerCommandAdapter } from "../../src/evaluation/agents/container-command";
import { cleanupContainers } from "../../src/evaluation/agents/docker";
import type { Invocation } from "../../src/evaluation/contracts";
import { publishInputs } from "../../src/evaluation/files";
import { command } from "../../src/evaluation/process";
import { task } from "../helpers/evaluation";

test("real offline command: isolation, artifacts, cancellation, timeout and owned cleanup", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "external-eval-")));
  const evaluationId = randomUUID();
  const unrelated = `eval-unrelated-${randomUUID()}`;
  const adapter = containerCommandAdapter();
  try {
    await writeFile(join(root, "data.csv"), "value\n1\n2\n");
    await publishInputs(root, task, join(root, "input"));
    const argv = [
      "uv",
      "run",
      "--offline",
      "--no-sync",
      "--frozen",
      "--project",
      "/opt/runtime",
      "python",
      "/opt/fixture.py",
    ];
    for (const unit of ["probe", "timeout", "cancel"])
      await mkdir(join(root, "deliverables", unit), { recursive: true });
    const i: Invocation = {
      schema_version: 2,
      evaluation_id: evaluationId,
      unit_id: "probe",
      task,
      config: {
        id: "external",
        adapter: adapter.id,
        options: {
          image: "statigent-evaluation-fixture:dev",
          argv: [...argv, "probe"],
        },
        model: null,
        require_seed: true,
      },
      budget: { timeout_ms: 10000, model_attempts: null, total_tokens: null },
      seed: 42,
      input_root: join(root, "input"),
      run_root: join(root, "runs"),
      deliverables_root: join(root, "deliverables", "probe"),
      trajectory: false,
    };
    await adapter.preflight(i.config);
    await command([
      "docker",
      "create",
      "--name",
      unrelated,
      "--label",
      "org.statigent.evaluation=unrelated",
      "statigent-evaluation-fixture:dev",
    ]);
    const success = await adapter.run(i);
    expect(success.status).toBe("completed");
    expect(success.answer_text).toBe("@sum[3]");
    // The host decodes inline command files into the unit's deliverables directory.
    expect(success.deliverables).toEqual([]);
    expect(
      await readFile(join(root, "deliverables", "probe", "result.txt"), "utf8"),
    ).toBe("3.0");
    expect(success.native_run).toBeNull();
    const timeout = await adapter.run({
      ...i,
      unit_id: "timeout",
      deliverables_root: join(root, "deliverables", "timeout"),
      config: {
        ...i.config,
        options: { ...i.config.options, argv: [...argv, "sleep"] },
      },
      budget: { ...i.budget, timeout_ms: 3000 },
    });
    expect(timeout.status).toBe("timed_out");
    expect(timeout.cleanup_error).toBeNull();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const cancelled = await adapter.run(
      {
        ...i,
        unit_id: "cancel",
        deliverables_root: join(root, "deliverables", "cancel"),
        config: {
          ...i.config,
          options: { ...i.config.options, argv: [...argv, "sleep"] },
        },
      },
      controller.signal,
    );
    clearTimeout(timer);
    expect(cancelled.status).toBe("cancelled");
    expect(
      (
        await command([
          "docker",
          "ps",
          "-aq",
          "--filter",
          `label=org.statigent.evaluation=${evaluationId}`,
        ])
      ).stdout.trim(),
    ).toBe("");
    expect(
      (
        await command(["docker", "inspect", unrelated, "--format", "{{.Name}}"])
      ).stdout.trim(),
    ).toBe(`/${unrelated}`);
  } finally {
    await cleanupContainers(evaluationId);
    await command(["docker", "rm", "-f", unrelated]);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
