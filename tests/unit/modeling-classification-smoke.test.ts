import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import multiclass from "../../configs/modeling/multiclass-prepare.json";
import models from "../../configs/models.json";
import {
  classificationPreflight,
  classificationSmoke,
  smokeArgs,
} from "../../src/modeling/classification-smoke";
import { prepareDataset } from "../../src/modeling/data";
import { obj } from "../../src/models/validation";
import { reply, ScriptClient } from "../helpers/agent";

test("classification smoke requires exactly one scope and preflights frozen data and budget without model calls", async () => {
  for (const args of [
    [],
    ["--kind", "both"],
    ["--kind", "binary", "--kind", "multiclass"],
    ["--kind", "binary", "--unknown"],
  ])
    expect(() => smokeArgs(args)).toThrow();
  expect(smokeArgs(["--kind", "binary", "--preflight"])).toEqual({
    kind: "binary",
    preflight: true,
  });
  const root = await mkdtemp(join(await realpath(tmpdir()), "class-smoke-"));
  for (const kind of ["binary", "multiclass"] as const) {
    const datasetRoot = join(root, kind);
    await prepareDataset(kind === "binary" ? binary : multiclass, datasetRoot);
    const p = await classificationPreflight(kind, datasetRoot);
    expect(p.selection.kind).toBe(kind);
    expect(p.config.budget).toMatchObject({
      task_timeout_ms: 900000,
      model_attempts: 40,
      total_tokens: 600000,
      training_attempts: 4,
      final_training_attempts: 1,
      final_reserve_ms: 180000,
      eda_calls: 1,
    });
    const client = new ScriptClient(() => reply());
    let calls = 0;
    // An injected failing run checks scope and persistence without starting a model or Docker.
    const result = await classificationSmoke(kind, {
      datasetRoot,
      runRoot: root,
      models,
      client,
      run: async (o) => {
        calls++;
        expect(obj(o.task).dataset_root).toBe(datasetRoot);
        throw Error("controlled failure");
      },
    });
    expect(calls).toBe(1);
    expect(client.bodies).toHaveLength(0);
    expect(result.status).toBe("failed");
    const path = join(result.directory, "smoke-result.json"),
      before = await readFile(path, "utf8");
    expect(JSON.parse(before)).toMatchObject({
      kind,
      status: "failed",
      run: null,
    });
    const again = await classificationSmoke(kind, {
      datasetRoot,
      runRoot: root,
      models,
      client,
      run: async () => {
        throw Error("second failure");
      },
    });
    expect(again.directory).not.toBe(result.directory);
    expect(await readFile(path, "utf8")).toBe(before);
  }
});
