import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { action } from "../../src/modeling/actions";
import { datasetProtocol, prepareDataset } from "../../src/modeling/data";
import { inspectModeling } from "../../src/modeling/records";
import { type ModelingOptions, runModeling } from "../../src/modeling/run";
import { obj } from "../../src/models/validation";
import { sha256 } from "../../src/records/store";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { trainCall } from "../helpers/modeling";

async function options(
  script: ConstructorParameters<typeof ScriptClient>[0],
): Promise<ModelingOptions> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "collaboration-loop-"),
  );
  await prepareDataset(source, join(root, "data"));
  return {
    task: {
      schema_version: 2,
      method: "collaborative",
      confirmation: { mode: "none" },
      resource_version: "smoke-v1",
      goal: "predict",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "test",
    },
    profile,
    edaProfile: profile,
    runRoot: root,
    client: new ScriptClient(script),
    experiment: async (o) => ({
      id: o.id ?? "test",
      candidate_id: o.candidateId,
      code: o.code,
      code_sha256: sha256(Buffer.from(o.code)),
      status: "completed",
      reason: "ok",
      score: o.final
        ? null
        : {
            metric: o.dataset.metric,
            direction: o.dataset.direction,
            value: 2,
            protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
            scoring_version: datasetProtocol(o.dataset).scoring_version,
          },
      fit: null,
      predict: null,
      final: o.final ?? false,
    }),
    delivery: async () => {
      throw new Error("stop after final experiment for audit probe");
    },
  };
}
function initial(body: Record<string, unknown>) {
  const messages = body.messages as { content: string | null }[];
  const raw = messages.find((m) =>
    m.content?.includes('"basic_profile_sha256"'),
  );
  const hash = obj(JSON.parse(raw?.content ?? "{}")).basic_profile_sha256;
  const train = trainCall();
  const parameters = obj(JSON.parse(train.function.arguments));
  return {
    ...parameters,
    candidate_updates: parameters.candidate_updates,
    knowledge_updates: [
      {
        op: "create",
        id: "o",
        kind: "observation",
        base_revision: null,
        statement: "Training sample is small",
        status: "active",
        reason: "Use simple models first",
        sources: [{ kind: "profile", profile_sha256: hash, path: "/rows" }],
        candidate_ids: ["baseline"],
      },
    ],
    knowledge_refs: [{ id: "o", revision: 1 }],
  };
}
test("joint decision persists knowledge and candidates; revisions audit and snapshot tampering rejects", async () => {
  const o = await options((body, i) =>
    i === 0
      ? reply([call("run_experiment", initial(body))])
      : reply([
          call("finish_modeling", {
            candidate_updates: [],
            experiment_id: lastFeedback(body).best_experiment_id,
            reason: "enough",
            knowledge_updates: [
              {
                op: "revise",
                id: "o",
                kind: "observation",
                base_revision: 1,
                statement: "Baseline score is available",
                status: "active",
                reason: "Record actual score separately",
                sources: [
                  {
                    kind: "experiment",
                    experiment_id: lastFeedback(body).best_experiment_id,
                    fact: "score",
                  },
                ],
                candidate_ids: ["baseline"],
              },
            ],
            knowledge_refs: [{ id: "o", revision: 2 }],
          }),
        ]),
  );
  const result = await runModeling(o),
    view = await inspectModeling(result.directory);
  const control = obj(view.knowledge_control);
  expect(control.history).toHaveLength(2);
  const manifest = view.manifest;
  const originalManifest = JSON.stringify(manifest);
  obj((obj(manifest.knowledge_control).history as unknown[])[1]).status =
    "withdrawn";
  await writeFile(
    join(result.directory, "modeling.json"),
    JSON.stringify(manifest),
  );
  await expect(inspectModeling(result.directory)).rejects.toThrow(
    "Knowledge snapshot",
  );
  await writeFile(join(result.directory, "modeling.json"), originalManifest);
  const eventPath = join(result.directory, "events.jsonl");
  const events = (await readFile(eventPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => obj(JSON.parse(line)));
  const accepted = events.find((e) => e.type === "action_accepted");
  if (!accepted) throw new Error("Missing fixture acceptance");
  events.push({ ...accepted, sequence: events.length + 1 });
  await writeFile(
    eventPath,
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  await expect(inspectModeling(result.directory)).rejects.toThrow();
}, 30000);

test("invalid knowledge rejects candidate creation and training as one decision", async () => {
  const o = await options((body) => {
    const p = initial(body);
    const source = p.knowledge_updates[0]?.sources[0];
    if (!source) throw new Error("Missing fixture source");
    source.path = "/missing";
    return reply([call("run_experiment", p)]);
  });
  const result = await runModeling(o);
  const manifest = JSON.parse(
    await readFile(join(result.directory, "modeling.json"), "utf8"),
  );
  expect(manifest.experiments).toEqual([]);
  expect(manifest.candidate_control.candidates).toEqual([]);
  expect(manifest.knowledge_control.history).toEqual([]);
}, 30000);

test("v3 exploration permits zero candidates and forbids legacy quotas and incorrect source cardinality", () => {
  const parameters = {
    candidate_updates: [],
    purpose: "explore",
    candidates: [],
    question: "Where are missing values?",
    expected_evidence: "Field missingness",
    source_experiments: [],
  };
  expect(action("analyze", JSON.stringify(parameters), 10000, 16).kind).toBe(
    "analyze",
  );
  for (const patch of [
    { requested_budget: { executions: 1 } },
    { source_experiments: ["e"] },
    { purpose: "compare", source_experiments: ["e", "e"] },
    { knowledge_updates: [] },
  ])
    expect(() =>
      action("analyze", JSON.stringify({ ...parameters, ...patch }), 10000, 16),
    ).toThrow();
  for (const method of ["no_eda", "initial_eda"] as const)
    expect(() =>
      action("analyze", JSON.stringify(parameters), 10000, 16, method),
    ).toThrow("disabled");
});

test("resource refusal and acceptance persistence failure leave knowledge and candidates unchanged", async () => {
  for (const mode of ["budget", "record"] as const) {
    const o = await options((body) => {
      const p = initial(body);
      return reply([
        call(
          mode === "budget" ? "analyze" : "run_experiment",
          mode === "budget"
            ? {
                candidate_updates: p.candidate_updates,
                knowledge_updates: p.knowledge_updates,
                knowledge_refs: p.knowledge_refs,
                purpose: "explore",
                candidates: [],
                source_experiments: [],
                question: "Explore missingness",
                expected_evidence: "Counts",
              }
            : p,
        ),
      ]);
    });
    if (mode === "budget")
      o.task = { ...obj(o.task), budget: { eda_calls: 0, model_attempts: 2 } };
    else {
      const { ModelingRecord } = await import("../../src/modeling/records");
      o.createRecord = async (...args) => {
        const r = await ModelingRecord.create(...args),
          original = r.event.bind(r);
        r.event = async (type, ...rest) => {
          if (type === "action_accepted")
            throw new Error("record_failure:injected");
          return original(type, ...rest);
        };
        return r;
      };
    }
    const result = await runModeling(o),
      m = JSON.parse(
        await readFile(join(result.directory, "modeling.json"), "utf8"),
      );
    expect(m.knowledge_control.history).toEqual([]);
    expect(m.candidate_control.candidates).toEqual([]);
    expect(m.experiments).toEqual([]);
    expect(m.analyses).toEqual([]);
  }
}, 30000);
