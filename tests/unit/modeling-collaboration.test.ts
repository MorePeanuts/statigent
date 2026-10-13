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
            evaluation_id: o.evaluation?.evaluation_id,
            protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
            scoring_version: datasetProtocol(o.dataset).scoring_version,
          },
      fit: null,
      predict: null,
      final: o.final ?? false,
      phase: o.evaluation?.phase,
      evaluation: o.evaluation,
      source_search_experiment_id: o.sourceSearchExperimentId ?? null,
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
test("successful training ends a correction episode; later mistakes do not exhaust a task-wide lifetime allowance", async () => {
  const o = await options((body, i) => {
    if (i < 3) {
      const args = initial(body);
      const first = args.knowledge_updates[0];
      if (!first) throw new Error("Missing fixture update");
      if (i < 2) first.kind = "hypothesis";
      return reply([call("run_experiment", args)]);
    }
    if (i === 3) {
      expect(obj(lastFeedback(body).recovery).consecutive_rejections).toBe(0);
      expect(obj(obj(lastFeedback(body).result).comparison)).toEqual({
        previous_best: null,
        improved: null,
      });
    }
    return reply([
      call("finish_modeling", {
        candidate_updates: [],
        experiment_id:
          i === 3 ? "nonexistent" : lastFeedback(body).best_experiment_id,
        reason: "No further promising changes",
      }),
    ]);
  });
  const result = await runModeling(o);
  expect(result.reason).toContain("audit probe");
  expect((o.client as ScriptClient).bodies).toHaveLength(5);
  expect(
    (await inspectModeling(result.directory)).manifest.experiments,
  ).toHaveLength(2);
});

test("accepting a failed training attempt does not reset consecutive rejection protection", async () => {
  const o = await options((body, i) => {
    if (i === 1) return reply([call("run_experiment", initial(body))]);
    return reply([
      call("finish_modeling", {
        candidate_updates: [],
        experiment_id: "missing",
        reason: "invalid",
      }),
    ]);
  });
  const base = o.experiment;
  if (!base) throw new Error("Missing experiment fixture");
  o.experiment = async (args) => ({
    ...(await base(args)),
    status: "failed",
    reason: "synthetic_code_failure",
    score: null,
  });
  const result = await runModeling(o);
  expect(result.reason).toBe("action_corrections");
  expect((o.client as ScriptClient).bodies).toHaveLength(4);
  expect(
    (await inspectModeling(result.directory)).manifest.experiments,
  ).toHaveLength(1);
});

test("repeating an unavailable resource request consumes bounded no-progress corrections", async () => {
  const o = await options(() =>
    reply([
      call("analyze", {
        candidate_updates: [],
        purpose: "explore",
        candidates: [],
        source_experiments: [],
        question: "Inspect data",
        expected_evidence: "Statistics",
      }),
    ]),
  );
  o.task = { ...obj(o.task), budget: { eda_calls: 0, model_attempts: 10 } };
  const result = await runModeling(o);
  expect(result.reason).toBe("action_corrections");
  expect((o.client as ScriptClient).bodies).toHaveLength(3);
  expect((await inspectModeling(result.directory)).manifest.analyses).toEqual(
    [],
  );
});
test.each(["pointer", "missing-source", "hypothesis-status"])(
  "knowledge format rejection gives actionable feedback and permits atomic correction: %s",
  async (mode) => {
    const o = await options((body, i) => {
      if (i >= 2)
        return reply([
          call("finish_modeling", {
            candidate_updates: [],
            knowledge_updates: [],
            knowledge_refs: [],
            experiment_id: lastFeedback(body).best_experiment_id,
            reason: "done",
          }),
        ]);
      const args = initial(body);
      if (i === 0) {
        const change = args.knowledge_updates[0];
        if (!change) throw Error("Missing observation");
        if (mode === "pointer") {
          const source = change.sources[0];
          if (!source) throw Error("Missing source");
          source.path = "basic_profile";
        }
        if (mode === "missing-source") change.sources = [];
        if (mode === "hypothesis-status") change.kind = "hypothesis";
      } else {
        const error = String(lastFeedback(body).error);
        expect(error).toContain(
          mode === "pointer"
            ? "/rows"
            : mode === "missing-source"
              ? "Observation requires a source: o"
              : "allowed: open, supported, challenged, withdrawn",
        );
      }
      return reply([call("run_experiment", args)]);
    });
    const result = await runModeling(o);
    const view = await inspectModeling(result.directory);
    expect(result.reason).not.toBe("action_corrections");
    expect(obj(view.knowledge_control).history).toHaveLength(1);
    expect(view.manifest.experiments).toHaveLength(2);
  },
);
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

for (const fail of [false, true])
  test(`terminal confirmation freezes model calls and ${fail ? "fails without fallback" : "selects the second search pipeline"}`, async () => {
    const { linearCode } = await import("../helpers/modeling");
    const o = await options((body, i) =>
      reply(
        i === 0
          ? [trainCall()]
          : i === 1
            ? [trainCall(linearCode, [], null, { candidateId: "second" })]
            : [
                call("finish_modeling", {
                  candidate_updates: [],
                  experiment_id: lastFeedback(body).best_experiment_id,
                  reason: "Freeze search",
                }),
              ],
      ),
    );
    o.task = {
      ...obj(o.task),
      confirmation: { mode: "terminal_repeated_holdout" },
      budget: {
        training_attempts: 8,
        final_reserve_ms: 750000,
        task_timeout_ms: 1200000,
      },
    };
    const base = o.experiment;
    if (!base) throw new Error("fixture");
    o.experiment = async (args) => {
      const e = await base(args);
      if (args.evaluation?.phase === "confirmation" && fail)
        return {
          ...e,
          status: "failed",
          score: null,
          reason: "planned timeout",
        };
      if (e.score)
        e.score = {
          ...e.score,
          value:
            args.evaluation?.phase === "confirmation"
              ? args.candidateId === "second"
                ? 1
                : 10
              : args.candidateId === "second"
                ? 2
                : 1,
        };
      return e;
    };
    const result = await runModeling(o),
      view = await inspectModeling(result.directory);
    expect((o.client as ScriptClient).bodies).toHaveLength(3);
    expect(obj(view.manifest.confirmation).status).toBe(
      fail ? "incomplete" : "complete",
    );
    if (fail) {
      expect(view.manifest.selected_experiment_id).toBeNull();
      expect(
        (view.manifest.experiments as { final: boolean }[]).some(
          (e) => e.final,
        ),
      ).toBe(false);
    } else {
      expect(view.manifest.selected_experiment_id).not.toBe(
        view.manifest.search_best_experiment_id,
      );
      const final = (
        view.manifest.experiments as { final: boolean; code: string }[]
      ).find((e) => e.final);
      expect(final?.code).toBe(linearCode);
    }
  }, 30000);

test("audit rejects a changed model seed or a confirmation identity reported as search", async () => {
  const o = await options((body, i) =>
    reply(
      i === 0
        ? [trainCall()]
        : [
            call("finish_modeling", {
              candidate_updates: [],
              experiment_id: lastFeedback(body).best_experiment_id,
              reason: "done",
            }),
          ],
    ),
  );
  const result = await runModeling(o),
    path = join(result.directory, "modeling.json"),
    text = await readFile(path, "utf8");
  for (const field of ["model_seed", "evaluation_id"]) {
    const m = obj(JSON.parse(text)),
      first = obj((m.experiments as unknown[])[0]),
      evaluation = obj(first.evaluation);
    evaluation[field] = field === "model_seed" ? 999 : "f".repeat(64);
    await writeFile(path, JSON.stringify(m));
    await expect(inspectModeling(result.directory)).rejects.toThrow(
      "evaluation",
    );
  }
}, 30000);
