import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { prepareDataset } from "../../src/modeling/data";
import { reproduce, scoreDelivery } from "../../src/modeling/delivery";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { obj } from "../../src/models/validation";
import { readManifest, sha256 } from "../../src/records/store";
import { lastFeedback, profile, reply, ScriptClient } from "../helpers/agent";
import {
  analyzeCall,
  modelingEdaScript,
  modelingScript,
} from "../helpers/modeling";

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      const p = join(e.parentPath, e.name);
      out[p] = sha256(await readFile(p));
    }
  return out;
}
async function expectContainersClean(events: Record<string, unknown>[]) {
  for (const event of events.filter((e) => e.type === "child_intent")) {
    const result = Bun.spawnSync([
      "docker",
      "ps",
      "-aq",
      "--filter",
      "label=org.statigent.runtime=1",
      "--filter",
      `label=org.statigent.run=${event.child_id}`,
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("");
  }
}
test("modeling keeps candidate identity through EDA, failed code and repair, then reproduces frozen predictions", async () => {
  const root = resolve("runs/integration-modeling-loop", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  const client = new ScriptClient(modelingScript(false, true)),
    edaClient = new ScriptClient(modelingEdaScript());
  const result = await runModeling({
    task: {
      goal: "Test synthetic loop",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      eda_profile: profile.id,
      image: "statigent-runtime:dev",
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
    edaClient,
  });
  expect(result.status, result.reason).toBe("completed");
  const view = await inspectModeling(result.directory);
  expect(view.unconfirmed_children).toHaveLength(0);
  expect(
    view.events.filter((e) => e.type === "experiment_result"),
  ).toHaveLength(4);
  expect(view.events.filter((e) => e.type === "child_intent")).toHaveLength(8);
  const experiments = (view.manifest.experiments as unknown[]).map(obj);
  const [baseline, failed, repaired, final] = experiments;
  expect(experiments.map((e) => e.status)).toEqual([
    "completed",
    "failed",
    "completed",
    "completed",
  ]);
  expect(failed?.candidate_id).toBe("linear");
  expect(repaired?.candidate_id).toBe(failed?.candidate_id);
  expect(repaired?.id).not.toBe(failed?.id);
  expect(final?.candidate_id).toBe("linear");
  expect(Number(repaired?.rmse)).toBeLessThan(Number(baseline?.rmse));
  expect(
    view.events.find(
      (e) => e.type === "experiment_intent" && e.experiment_id === repaired?.id,
    )?.repair_of_experiment,
  ).toBe(failed?.id);
  const candidates = (
    obj(view.manifest.candidate_control).candidates as unknown[]
  ).map(obj);
  expect(candidates).toHaveLength(2);
  expect(candidates.find((c) => c.id === "linear")).toMatchObject({
    status: "tried",
    experiment_ids: [failed?.id, repaired?.id, final?.id],
  });
  expect(
    candidates.find((c) => c.id === "linear")?.evidence as unknown[],
  ).toHaveLength(1);
  expect(client.bodies).toHaveLength(5);
  expect(edaClient.bodies).toHaveLength(4);
  await expectContainersClean(view.events);
  const json = JSON.stringify(client.bodies);
  expect(json).not.toContain("pd.read_csv");
  expect(json).not.toContain("/input/validation.csv");
  const before = await snapshot(result.directory);
  expect(
    (await reproduce(result.directory, join(root, "reproductions"))).status,
  ).toBe("passed");
  expect(
    (await reproduce(result.directory, join(root, "refits"), "refit")).status,
  ).toBe("passed");
  const labels = join(root, "private");
  await mkdir(labels);
  await writeFile(join(labels, "labels.csv"), "id,target\n13,26\n14,28\n");
  expect(
    (
      await scoreDelivery(
        result.directory,
        labels,
        "labels.csv",
        join(root, "scores"),
      )
    ).value,
  ).toBeLessThan(1e-8);
  expect(await snapshot(result.directory)).toEqual(before);
  const datasetPath = join(root, "data", "dataset.json");
  const original = await readFile(datasetPath, "utf8");
  const changed = JSON.parse(original);
  changed.seed++;
  await writeFile(datasetPath, JSON.stringify(changed));
  await expect(
    reproduce(result.directory, join(root, "mismatch")),
  ).rejects.toThrow("Frozen input identity mismatch");
  await writeFile(datasetPath, original);
  await writeFile(join(labels, "bad.csv"), "id,target\n13,26\n15,28\n");
  await expect(
    scoreDelivery(result.directory, labels, "bad.csv", join(root, "scores")),
  ).rejects.toThrow("membership");
  console.log(JSON.stringify({ kind: "modeling_integration", ...result }));
}, 240000);

test("two EDA calls use distinct requested allowances, shared parent costs and independent kernels", async () => {
  const root = resolve("runs/integration-modeling-loop", randomUUID());
  await mkdir(root, { recursive: true });
  await prepareDataset(source, join(root, "data"));
  const base = modelingScript(false, false, {
      task_timeout_ms: 90000,
      total_tokens: 100000,
      executions: 1,
    }),
    eda = modelingEdaScript();
  const client = new ScriptClient((body, i) => {
    if (i === 2) {
      const previous = obj(lastFeedback(body).result);
      return reply([
        analyzeCall(String(previous.source_experiment), {
          candidateUpdates: [],
          requestedBudget: {
            task_timeout_ms: 120000,
            total_tokens: 500000,
            executions: 3,
          },
        }),
      ]);
    }
    return base(body, i > 2 ? i - 1 : i);
  });
  const result = await runModeling({
    task: {
      goal: "Two independent analyses",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
      budget: {
        eda_calls: 2,
        eda_executions: 2,
        total_tokens: 300000,
        eda_tokens: 400000,
      },
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client,
    edaClient: new ScriptClient((body, i) => eda(body, i % 4)),
  });
  expect(result.status, result.reason).toBe("completed");
  const { manifest, events } = await inspectModeling(result.directory);
  const analyses = manifest.analyses;
  if (!Array.isArray(analyses)) throw Error("missing analyses");
  expect(analyses).toHaveLength(2);
  expect(obj(analyses[0]).run_id).not.toBe(obj(analyses[1]).run_id);
  const allocations = events
    .filter(
      (e) => e.type === "action_accepted" && obj(e.intent).kind === "analysis",
    )
    .map((e) => obj(obj(e.intent).allocation));
  expect(allocations.map((a) => obj(a.requested).total_tokens)).toEqual([
    100000, 500000,
  ]);
  expect(allocations.map((a) => obj(a.effective).total_tokens)).toEqual([
    100000, 299895,
  ]);
  expect(allocations.map((a) => obj(a.effective).executions)).toEqual([1, 1]);
  expect(allocations[1]?.clipped).toContainEqual({
    dimension: "total_tokens",
    constraint: "remaining",
    limit: 299895,
  });
  expect(allocations[1]?.clipped).toContainEqual({
    dimension: "executions",
    constraint: "remaining",
    limit: 1,
  });
  for (const [index, analysis] of analyses.entries()) {
    const record = obj(analysis);
    const child = await readManifest(String(record.directory));
    if (
      !child.agent ||
      child.agent === "not_applicable" ||
      !child.collaboration ||
      child.tokens === "not_applicable"
    )
      throw new Error("Missing EDA metadata");
    const effective = obj(allocations[index]?.effective);
    expect(record.effective_budget).toEqual(effective);
    for (const dimension of [
      "task_timeout_ms",
      "total_tokens",
      "executions",
      "model_attempts",
    ] as const)
      expect(child.agent.budget[dimension]).toBe(Number(effective[dimension]));
    expect(child.tokens.total_tokens).toBe(60);
    expect(child.collaboration.roles.planner.tokens.total_tokens).toBe(30);
    expect(child.collaboration.roles.executor.tokens.total_tokens).toBe(30);
    expect(child.agent.executions).toBe(1);
  }
  const usage = obj(manifest.usage);
  expect(obj(usage.tokens).total_tokens).toBe(195);
  expect(obj(usage.modeling).total_tokens).toBe(75);
  expect(usage.eda_executions).toBe(2);
  expect(usage.eda_calls).toBe(2);
  await expectContainersClean(events);
}, 180000);
