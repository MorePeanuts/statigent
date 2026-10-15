import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineAdapter } from "../../src/baselines/adapter";
import { readPredictionManifest } from "../../src/evaluation/predictions";
import { modelingInvocation } from "../helpers/evaluation-modeling";

test("AutoGluon independently trains both targets, freezes and predicts without LLM", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-automl-")),
  );
  try {
    const i = await modelingInvocation(root);
    i.config = {
      ...i.config,
      id: "autogluon",
      adapter: "autogluon",
      model: null,
      options: {
        schema_version: 1,
        method: "autogluon",
        image: "statigent-runtime:autogluon-cpu-v1",
        delivery_reserve_ms: 45000,
      },
    };
    i.budget = { timeout_ms: 150000, model_attempts: null, total_tokens: null };
    const result = await baselineAdapter("autogluon").run(
      i,
      new AbortController().signal,
    );
    expect(result.reason).toBe("explicit_submission");
    expect(result.status).toBe("completed");
    expect(result.usage.attempts).toBe(0);
    const manifest = await readPredictionManifest(i.deliverables_root, i.task, {
      seed: i.seed,
      exported: false,
    });
    expect(manifest.producer?.method).toBe("autogluon");
    const run = join(i.run_root, (await readdir(i.run_root))[0] ?? "missing");
    const training = JSON.parse(
      await readFile(join(run, "bundle/files/training.json"), "utf8"),
    );
    expect(training.complete).toBe(true);
    expect(training.targets.map((x: { target: string }) => x.target)).toEqual([
      "EC1",
      "EC2",
    ]);
    expect(training.targets[1].allowance_seconds).toBeLessThan(150);
  } finally {
    for (const run of await readdir(join(root, "native"))) {
      const files = join(root, "native", run, "bundle/files");
      if (await Bun.file(join(files, "predict.py")).exists())
        await chmod(files, 0o755);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 210000);
