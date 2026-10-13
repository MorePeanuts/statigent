import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { prepareDataset } from "../../src/modeling/data";
import { reproduce } from "../../src/modeling/delivery";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { ModelFailure } from "../../src/models/client";
import { obj } from "../../src/models/validation";
import { profile, reply, ScriptClient } from "../helpers/agent";
import {
  modelingEdaScript,
  modelingScript,
  trainCall,
} from "../helpers/modeling";

test("unknown last EDA planner usage after real execution closes search and confirms without another model call", async () => {
  const root = resolve("runs/integration-protection", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  const script = modelingEdaScript(),
    client = new ScriptClient(modelingScript()),
    edaClient = new ScriptClient((body, i) => {
      if (i === 3)
        throw new ModelFailure("transport_or_protocol_failure", "unknown");
      if (i > 3)
        throw new Error("No model call authorized after unknown usage");
      return script(body, i);
    });
  const result = await runModeling({
    task: {
      schema_version: 3,
      method: "collaborative",
      confirmation: { mode: "terminal_repeated_holdout" },
      resource_version: "protection-test-v1",
      goal: "predict",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
      budget: {
        training_attempts: null,
        task_timeout_ms: 1200000,
        final_reserve_ms: 750000,
      },
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
    edaClient,
  });
  expect(result.status, result.reason).toBe("completed");
  expect(client.bodies).toHaveLength(2);
  expect(edaClient.bodies).toHaveLength(4);
  const view = await inspectModeling(result.directory),
    m = view.manifest;
  expect(m.search_end).toEqual({
    kind: "protected",
    reason: "accounting_incomplete",
  });
  expect(m.delivery).toMatchObject({ status: "completed" });
  expect(m.usage).toMatchObject({
    tokens: { status: "unknown", attempts: 6, unknown_attempts: 1 },
    eda_executions: 1,
    confirmation_training_attempts: 2,
    training_attempts: 4,
  });
  expect((m.analyses as unknown[]).map(obj)).toMatchObject([
    { status: "failed", analysis: null, execution_confirmed: true },
  ]);
  expect(view.events.filter((e) => e.type === "search_frozen")).toHaveLength(1);
  expect(view.unconfirmed_children).toHaveLength(0);
  expect(
    (await reproduce(result.directory, join(root, "reproductions"))).status,
  ).toBe("passed");
  const path = join(result.directory, "modeling.json"),
    bytes = await Bun.file(path).text(),
    changed = JSON.parse(bytes);
  changed.search_end = { kind: "agent_finished", reason: "done" };
  await Bun.write(path, JSON.stringify(changed));
  await expect(inspectModeling(result.directory)).rejects.toThrow();
  await Bun.write(path, bytes);
}, 180000);

test("model request cap after a real search permits final delivery without inventing finish", async () => {
  const root = resolve("runs/integration-protection", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  const client = new ScriptClient(() => reply([trainCall()]));
  const result = await runModeling({
    task: {
      schema_version: 3,
      method: "no_eda",
      confirmation: { mode: "none" },
      resource_version: "protection-test-v1",
      goal: "predict",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
      budget: { model_attempts: 1 },
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
  });
  expect(result.status, result.reason).toBe("completed");
  expect(client.bodies).toHaveLength(1);
  const view = await inspectModeling(result.directory);
  expect(view.manifest.search_end).toEqual({
    kind: "protected",
    reason: "model_attempts",
  });
  expect(
    (await reproduce(result.directory, join(root, "reproductions"))).status,
  ).toBe("passed");
}, 120000);
