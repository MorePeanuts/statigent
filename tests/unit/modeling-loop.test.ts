import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { DEFAULT_BUDGET } from "../../src/agent/config";
import { action } from "../../src/modeling/actions";
import { datasetProtocol, prepareDataset } from "../../src/modeling/data";
import { validateEvidence } from "../../src/modeling/eda";
import { inspectModeling, ModelingRecord } from "../../src/modeling/records";
import { type ModelingOptions, runModeling } from "../../src/modeling/run";
import { ModelFailure, normalizeUsage } from "../../src/models/client";
import { obj } from "../../src/models/validation";
import { emptyLedger } from "../../src/records/agent-metadata";
import { RunRecorder, sha256 } from "../../src/records/store";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { collaborationMetadata } from "../helpers/collaboration";
import {
  analyzeCall,
  baselineCode,
  createCandidate,
  finishCall,
  modelingScript,
  trainCall,
  updateCandidate,
} from "../helpers/modeling";

async function options(
  script: ConstructorParameters<typeof ScriptClient>[0],
  prepare: unknown = source,
): Promise<ModelingOptions> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "modeling-loop-"));
  await prepareDataset(prepare, join(root, "data"));
  let count = 0;
  return {
    task: {
      schema_version: 2,
      method: "adaptive_eda",
      confirmation: { mode: "none" },
      resource_version: "smoke-v1",

      goal: "test",
      dataset_root: join(root, "data"),
      model_profile: profile.id,
      image: "statigent-runtime:dev",
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
            direction: datasetProtocol(o.dataset).direction,
            protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
            scoring_version: datasetProtocol(o.dataset).scoring_version,
            value: ++count,
            evaluation_id: o.evaluation?.evaluation_id,
          },
      fit: null,
      predict: null,
      final: o.final ?? false,
      phase: o.evaluation?.phase,
      evaluation: o.evaluation,
      source_search_experiment_id: o.sourceSearchExperimentId ?? null,
    }),
    analysis: async (o) => {
      const result = {
        id: o.id,
        run_id: o.runId,
        directory: join(o.root, "eda", o.runId),
        dispatch: "started" as const,
        effective_budget: o.budget,
        deadline: o.deadline,
        source_experiment: o.request.source_experiments[0] ?? null,
        dataset_hash: o.dataset.files[0]?.sha256 ?? "",
        split_hash: o.dataset.split.sha256,
        protocol_sha256: datasetProtocol(o.dataset).protocol_sha256,
        prediction_sha256: o.experiment?.predict?.output?.sha256 ?? null,
        status: "completed",
        reason: "ok",
        analysis: {
          summary: "Observation",
          findings: [{ statement: "Finding", evidence_refs: ["ref1"] }],
          methods: ["synthetic"],
          limitations: [],
        },
        cost: {
          ...emptyLedger(),
          attempts: 4,
          input_tokens: 40,
          output_tokens: 20,
          total_tokens: 60,
        },
        role_usage: {
          planner: {
            ...emptyLedger(),
            attempts: 2,
            input_tokens: 20,
            output_tokens: 10,
            total_tokens: 30,
          },
          executor: {
            ...emptyLedger(),
            attempts: 2,
            input_tokens: 20,
            output_tokens: 10,
            total_tokens: 30,
          },
        },
        executions: 1,
        request: o.request,
      };
      const collaboration = collaborationMetadata();
      collaboration.roles.planner.tokens = result.role_usage.planner;
      collaboration.roles.executor.tokens = result.role_usage.executor;
      collaboration.subtasks.push({
        subtask_id: "subtask",
        tool_id: "delegate",
        status: "completed",
        tokens: result.role_usage.executor,
        evidence_refs: ["ref1"],
      });
      const child = await RunRecorder.create({
        runRoot: join(o.root, "eda"),
        runId: o.runId,
        config: {},
        inputs: [],
        image: { id: "fixture", platform: "linux/arm64" },
        agent: {
          model: structuredClone(collaboration.roles.planner.model),
          prompt: { version: "fixture", sha256: "a".repeat(64) },
          tokens: result.cost,
          collaboration,
          metadata: {
            goal: "test",
            constraints: [],
            budget: { ...DEFAULT_BUDGET, ...o.budget },
            remaining: {
              model_attempts: o.budget.model_attempts - 4,
              executions: o.budget.executions - 1,
              tokens: o.budget.total_tokens - 60,
              task_ms: o.budget.task_timeout_ms,
            },
            executions: 1,
            termination: null,
            final_result: null,
            trace_bytes: 0,
            trace_incomplete: false,
          },
        },
      });
      await child.finish("completed");
      return result;
    },
    delivery: async (_root, task, selected, final, dataset) => ({
      schema_version: 2,
      stage_version: 3,
      protocol: datasetProtocol(dataset),
      source_experiment: selected.id,
      dataset,
      model_environment: {},
      code_version: { commit: null, dirty: null },
      validation_score: selected.score,
      final_experiment: final.id,
      task,
      image: { id: "test", platform: "test" },
      files: [],
      created_at: "test",
      prediction_tolerance: { atol: 1e-8, rtol: 1e-6 },
    }),
  };
}
test("EDA evidence drives follow-up while worse scores preserve original best and exact shared cost", async () => {
  const o = await options(modelingScript(true)),
    r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  const { manifest } = await inspectModeling(r.directory);
  const firstBody = (o.client as ScriptClient).bodies[0];
  const firstMessages = obj(firstBody).messages as {
    role: string;
    content: string;
  }[];
  const initial = firstMessages.find((m) => m.role === "user");
  expect(JSON.parse(initial?.content ?? "{}").execution_limits).toMatchObject({
    max_artifact_bytes: 256 * 1024 ** 2,
  });
  const experiments = manifest.experiments as { id: string }[];
  expect(r.best_experiment_id).toBe(experiments[0]?.id ?? null);
  expect(manifest.usage).toMatchObject({
    tokens: { attempts: 8, total_tokens: 120 },
    modeling: { attempts: 4, total_tokens: 60 },
    eda_calls: 1,
    training_attempts: 3,
  });
});
test("direct training may finish without EDA; malformed multi-actions and missing best never execute", async () => {
  let dispatched = 0;
  const o = await options((body, i) =>
    reply(
      i === 0
        ? [trainCall(), trainCall()]
        : i === 1
          ? [
              call("finish_modeling", {
                candidate_updates: [],
                experiment_id: "fake",
                reason: "fake",
              }),
            ]
          : i === 2
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
  const execute = o.experiment;
  o.experiment = async (input) => {
    dispatched++;
    if (!execute) throw Error("missing fixture");
    return execute(input);
  };
  const r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  expect(dispatched).toBe(2);
  expect((await inspectModeling(r.directory)).manifest.analyses).toEqual([]);
});
test("unknown model usage stops and retry attempts are included", async () => {
  const bad = await options(() => {
    throw new ModelFailure("connection_lost", "unknown");
  });
  const r = await runModeling(bad);
  expect(r.status).toBe("failed");
  expect(r.reason).toBe("accounting_incomplete");
  const retry = await options((body, i) => {
    if (i === 0)
      throw new ModelFailure(
        "rate_limit",
        "not_generated",
        true,
        normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }),
      );
    return reply([
      i === 1
        ? trainCall()
        : call("finish_modeling", {
            candidate_updates: [],
            experiment_id: lastFeedback(body).best_experiment_id,
            reason: "done",
          }),
    ]);
  });
  const good = await runModeling(retry);
  expect(good.status, good.reason).toBe("completed");
  expect((await inspectModeling(good.directory)).manifest.usage).toMatchObject({
    tokens: { attempts: 3, total_tokens: 30 },
  });
});
test("invalid evidence scopes and unsupported actions rejected", () => {
  expect(() => action("unknown", "{}", 1000, 2)).toThrow();
  expect(() =>
    action(
      "run_experiment",
      trainCall(baselineCode, [
        {
          analysis_id: "a",
          source_experiment: null,
          refs: [],
          applicability: "none",
        },
      ]).function.arguments,
      1000,
      2,
    ),
  ).toThrow();
  expect(() =>
    validateEvidence(
      [
        {
          analysis_id: "missing",
          source_experiment: null,
          refs: ["r"],
          applicability: "none",
        },
      ],
      [],
      {
        schema_version: 1,
        kind: "regression",
        metric: "rmse",
        direction: "minimize",
        target: "y",
        id_column: "id",
        seed: 1,
        files: [],
        split: { train: [], validation: [], sha256: "none" },
        features: [],
      },
    ),
  ).toThrow();
});

test("known analysis failure is diagnostic, unknown child cost terminates, and cancellation reaches active analysis", async () => {
  const script = modelingScript();
  const o = await options(script);
  const original = o.analysis;
  if (!original) throw Error("missing fixture");
  o.analysis = async (input) => {
    const cost = {
      ...emptyLedger(),
      status: "unknown" as const,
      attempts: 1,
      unknown_attempts: 1,
    };
    return {
      ...(await original(input)),
      cost,
      role_usage: { planner: cost, executor: emptyLedger() },
    };
  };
  const failed = await runModeling(o);
  expect(failed.status).toBe("failed");
  expect(failed.reason).toContain("accounting_incomplete");
  const controller = new AbortController();
  const c = await options(modelingScript());
  c.signal = controller.signal;
  let propagated = false;
  c.analysis = async (input) => {
    controller.abort();
    propagated = input.signal.aborted;
    return { ...(await original(input)), status: "cancelled", analysis: null };
  };
  const cancelled = await runModeling(c);
  expect(cancelled.status).toBe("cancelled");
  expect(propagated).toBe(true);
});

test("failed finalization or missing delivery never becomes completed", async () => {
  const direct = (body: Record<string, unknown>, i: number) =>
    reply([
      i === 0
        ? trainCall()
        : call("finish_modeling", {
            candidate_updates: [],
            experiment_id: lastFeedback(body).best_experiment_id,
            reason: "done",
          }),
    ]);
  const a = await options(direct);
  const ex = a.experiment;
  if (!ex) throw Error("fixture");
  a.experiment = async (input) => {
    const e = await ex(input);
    return input.final ? { ...e, status: "failed", reason: "fit error" } : e;
  };
  const failed = await runModeling(a);
  expect(failed.status).toBe("failed");
  expect(failed.best_experiment_id).not.toBeNull();
  const b = await options(direct);
  b.delivery = async () => {
    throw Error("missing complete model");
  };
  expect((await runModeling(b)).status).toBe("failed");
});

test("final retries use new experiments, unchanged code and the configured reserved attempts", async () => {
  const direct = (body: Record<string, unknown>, i: number) =>
    reply([
      i === 0
        ? trainCall()
        : call("finish_modeling", {
            candidate_updates: [],
            experiment_id: lastFeedback(body).best_experiment_id,
            reason: "done",
          }),
    ]);
  const o = await options(direct);
  o.task = {
    ...obj(o.task),
    budget: { final_training_attempts: 2, final_reserve_ms: 300000 },
  };
  const ex = o.experiment;
  if (!ex) throw Error("fixture");
  let finalAttempts = 0;
  const codes: string[] = [];
  o.experiment = async (input) => {
    const e = await ex(input);
    codes.push(input.code);
    if (input.final && ++finalAttempts === 1)
      return {
        ...e,
        status: "failed",
        reason: "error:transient fixture failure",
      };
    return e;
  };
  const result = await runModeling(o);
  expect(result.status, result.reason).toBe("completed");
  expect(finalAttempts).toBe(2);
  expect(new Set(codes).size).toBe(1);
});

test.each([
  "error:bad candidate",
  "model_artifact_limit:compressed model bytes=512 exceeds max_bytes=256",
])(
  "a failed training attempt can be explicitly referenced by its bounded repair: %s",
  async (reason) => {
    const o = await options((body, i) =>
      reply([
        i === 0
          ? trainCall()
          : i === 1
            ? trainCall(baselineCode, [], null, {
                candidateId: "baseline",
                candidateUpdates: [],
                repairOf: String(obj(lastFeedback(body).result).experiment_id),
              })
            : call("finish_modeling", {
                candidate_updates: [],
                experiment_id: lastFeedback(body).best_experiment_id,
                reason: "done",
              }),
      ]),
    );
    const ex = o.experiment;
    if (!ex) throw Error("fixture");
    let attempts = 0;
    o.experiment = async (input) => {
      const e = await ex(input);
      return attempts++ === 0
        ? { ...e, status: "failed", reason, score: null }
        : e;
    };
    const r = await runModeling(o);
    expect(r.status, r.reason).toBe("completed");
    expect(attempts).toBe(3);
  },
);

test.each([
  "output_limit_exceeded:incomplete execution",
  "cleanup:model_artifact_limit",
  "record_failure:model_artifact_limit",
])(
  "unknown or unclean artifact failure stops without repair: %s",
  async (reason) => {
    const o = await options(() => reply([trainCall()]));
    const ex = o.experiment;
    if (!ex) throw Error("fixture");
    let attempts = 0;
    o.experiment = async (input) => {
      attempts++;
      return { ...(await ex(input)), status: "failed", reason, score: null };
    };
    const r = await runModeling(o);
    expect(r.status).toBe("failed");
    expect(r.reason).toBe(reason);
    expect(attempts).toBe(1);
  },
);

test("candidate batches and budget rejection are atomic while model costs remain charged", async () => {
  for (const mode of ["batch", "budget", "evidence"] as const) {
    const o = await options((body, i) => {
      if (i === 0) {
        const updates = [createCandidate("ghost")];
        const tool =
          mode === "budget"
            ? analyzeCall(null, {
                candidates: ["ghost"],
                candidateUpdates: updates,
              })
            : trainCall(baselineCode, [], null, {
                candidateId: "ghost",
                candidateUpdates: [
                  ...updates,
                  mode === "batch"
                    ? updateCandidate("missing")
                    : {
                        ...createCandidate("other"),
                        evidence: [
                          {
                            analysis_id: "missing",
                            source_experiment: null,
                            refs: ["r"],
                            applicability: "invalid",
                          },
                        ],
                      },
                ],
              });
        return reply([tool]);
      }
      if (i === 1) {
        expect(lastFeedback(body).candidates).toEqual([]);
        return reply([trainCall()]);
      }
      return reply([finishCall(body)]);
    });
    if (mode === "budget")
      o.task = { ...obj(o.task), budget: { eda_calls: 0 } };
    const r = await runModeling(o);
    expect(r.status, r.reason).toBe("completed");
    const inspected = await inspectModeling(r.directory);
    expect(obj(inspected.manifest.candidate_control).candidates).toMatchObject([
      { id: "baseline" },
    ]);
    expect(
      obj(inspected.manifest.candidate_control).candidates as unknown[],
    ).toHaveLength(1);
    expect(inspected.manifest.usage).toMatchObject({
      tokens: { attempts: 3, total_tokens: 45 },
      training_attempts: 2,
      eda_calls: 0,
    });
  }
});

test("deferred candidates require explicit resume and priority does not force scheduling", async () => {
  const o = await options((body, i) => {
    if (i === 0)
      return reply([
        trainCall(baselineCode, [], null, {
          candidateUpdates: [
            createCandidate("baseline", 2),
            createCandidate("alternative", 1),
          ],
        }),
      ]);
    if (i === 1)
      return reply([
        trainCall(baselineCode, [], null, {
          candidateUpdates: [updateCandidate("baseline", [], "defer")],
        }),
      ]);
    if (i === 2) {
      expect(
        (
          lastFeedback(body).candidates as { id: string; status: string }[]
        ).find((c) => c.id === "baseline")?.status,
      ).toBe("tried");
      return reply([
        trainCall(baselineCode, [], null, {
          candidateId: "alternative",
          candidateUpdates: [updateCandidate("baseline", [], "defer")],
        }),
      ]);
    }
    if (i === 3)
      return reply([
        trainCall(baselineCode, [], null, {
          candidateUpdates: [updateCandidate("baseline", [], "resume", 3)],
        }),
      ]);
    return reply([
      finishCall(body, [updateCandidate("alternative", [], "defer")]),
    ]);
  });
  const r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  const m = (await inspectModeling(r.directory)).manifest;
  expect(obj(m.candidate_control).candidates).toMatchObject([
    { id: "baseline", priority: 3, status: "tried", revision: 6 },
    { id: "alternative", priority: 1, status: "deferred", revision: 3 },
  ]);
  expect(
    (m.experiments as { candidate_id: string }[]).map((e) => e.candidate_id),
  ).toEqual(["baseline", "alternative", "baseline", "baseline"]);
});

test("failed acceptance persistence dispatches nothing and leaves only the prior snapshot", async () => {
  const o = await options(() => reply([trainCall()]));
  let calls = 0;
  o.experiment = async () => {
    calls++;
    throw Error("must not execute");
  };
  o.createRecord = async (...args) => {
    const r = await ModelingRecord.create(...args);
    const event = r.event.bind(r);
    r.event = async (type, fields, payload) => {
      if (type === "action_accepted")
        throw Error("record_failure:injected acceptance failure");
      return event(type, fields, payload);
    };
    return r;
  };
  const r = await runModeling(o);
  expect(r.status).toBe("failed");
  expect(r.record_error).toBe(true);
  expect(calls).toBe(0);
  const m = (await inspectModeling(r.directory)).manifest;
  expect(obj(m.candidate_control).candidates).toEqual([]);
  expect(m.usage).toMatchObject({
    tokens: { attempts: 1, total_tokens: 15 },
    training_attempts: 0,
  });
});

test("accepted decision survives interruption without inventing execution and unknown training never retries", async () => {
  for (const stage of ["snapshot", "execution"] as const) {
    const o = await options(() => reply([trainCall()]));
    let calls = 0;
    o.experiment = async () => {
      calls++;
      throw Error("unconfirmed runtime");
    };
    if (stage === "snapshot")
      o.createRecord = async (...args) => {
        const r = await ModelingRecord.create(...args);
        const save = r.save.bind(r);
        r.save = async (state) => {
          if (obj(state.candidate_control).applied_sequence !== 0)
            throw Error("record_failure:injected snapshot failure");
          return save(state);
        };
        return r;
      };
    const r = await runModeling(o);
    expect(r.status).toBe("failed");
    expect(calls).toBe(stage === "snapshot" ? 0 : 1);
    const inspected = await inspectModeling(r.directory);
    expect(inspected.unconfirmed_experiments).toHaveLength(1);
    expect(obj(inspected.candidate_control).candidates).toMatchObject([
      { id: "baseline", status: "tried" },
    ]);
  }
});

test("cancellation after request persistence charges no unstarted attempt", async () => {
  const controller = new AbortController();
  const o = await options(() => {
    throw Error("must not dispatch");
  });
  o.signal = controller.signal;
  o.createRecord = async (...args) => {
    const r = await ModelingRecord.create(...args);
    const event = r.event.bind(r);
    r.event = async (type, fields, payload) => {
      const seq = await event(type, fields, payload);
      if (type === "model_request") controller.abort();
      return seq;
    };
    return r;
  };
  const r = await runModeling(o);
  expect(r.status).toBe("cancelled");
  expect((await inspectModeling(r.directory)).manifest.usage).toMatchObject({
    tokens: { attempts: 0 },
    modeling: { attempts: 0 },
  });
});

test("classification loops honor maximize/minimize, keep earlier ties and reject altered records", async () => {
  const binary = await Bun.file("configs/modeling/binary-prepare.json").json();
  for (const metric of ["accuracy", "log_loss"]) {
    const o = await options(modelingScript(true), { ...binary, metric });
    const execute = o.experiment;
    if (!execute) throw Error("fixture");
    let count = 0;
    o.experiment = async (args) => {
      const e = await execute(args);
      if (e.score) e.score.value = metric === "accuracy" ? 0.8 : 0.2;
      if (!args.final) count++;
      return e;
    };
    const r = await runModeling(o);
    expect(r.status, r.reason).toBe("completed");
    expect(count).toBe(2);
    const view = await inspectModeling(r.directory),
      experiments = (view.manifest.experiments as unknown[]).map(obj);
    expect(r.best_experiment_id).toBe(String(experiments[0]?.id));
    const first = JSON.stringify((o.client as ScriptClient).bodies[0]);
    expect(first).toContain(metric);
    expect(first).toContain(metric === "accuracy" ? "maximize" : "minimize");
    const path = join(r.directory, "modeling.json"),
      original = await Bun.file(path).text(),
      m = JSON.parse(original);
    m.config.protocol.direction =
      metric === "accuracy" ? "minimize" : "maximize";
    await Bun.write(path, JSON.stringify(m));
    await expect(inspectModeling(r.directory)).rejects.toThrow();
    await Bun.write(path, original);
  }
});
test("scoring failure terminates the parent without dispatching another experiment", async () => {
  const o = await options(() => reply([trainCall()])),
    execute = o.experiment;
  if (!execute) throw Error("fixture");
  let dispatched = 0;
  o.experiment = async (args) => {
    dispatched++;
    return {
      ...(await execute(args)),
      status: "failed",
      reason: "scoring_failure:timeout",
      score: null,
    };
  };
  const r = await runModeling(o);
  expect(r.status).toBe("failed");
  expect(dispatched).toBe(1);
  expect((o.client as ScriptClient).bodies).toHaveLength(1);
  expect(
    (await inspectModeling(r.directory)).manifest.best_experiment_id,
  ).toBeNull();
});

test("new modeling run preserves a legacy regression dataset and records a v3 parent with the original metric protocol", async () => {
  const o = await options((body, i) =>
    reply([i === 0 ? trainCall() : finishCall(body)]),
  );
  const path = join(String(obj(o.task).dataset_root), "dataset.json");
  const dataset = obj(await Bun.file(path).json());
  dataset.schema_version = 1;
  delete dataset.protocol;
  delete dataset.split_method;
  const original = JSON.stringify(dataset);
  await Bun.write(path, original);
  const result = await runModeling(o);
  expect(result.status, result.reason).toBe("completed");
  const view = await inspectModeling(result.directory);
  expect(view.manifest.schema_version).toBe(3);
  expect(obj(view.manifest.config).dataset).toMatchObject({
    schema_version: 1,
  });
  expect(obj(view.manifest.config).protocol).toMatchObject({
    kind: "regression",
    metric: "rmse",
  });
  expect(await Bun.file(path).text()).toBe(original);
});

test("two explorations may precede candidate creation and the agent may decline both reports", async () => {
  const o = await options((body, i) =>
    reply(
      i < 2
        ? [analyzeCall(null, { candidates: [], candidateUpdates: [] })]
        : i === 2
          ? [trainCall()]
          : [finishCall(body)],
    ),
  );
  o.task = { ...obj(o.task), budget: { eda_calls: 2 } };
  const r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  const { manifest } = await inspectModeling(r.directory);
  expect(manifest.analyses).toHaveLength(2);
  const candidates = obj(manifest.candidate_control).candidates as unknown[];
  expect(candidates).toHaveLength(1);
  expect(manifest.usage).toMatchObject({ eda_calls: 2, training_attempts: 2 });
}, 30000);

test("training can use earlier valid evidence after a newer analysis", async () => {
  let evidence: unknown[] = [];
  const o = await options((body, i) => {
    if (i < 2) {
      if (i === 1) {
        const a = obj(lastFeedback(body).result);
        evidence = [
          {
            analysis_id: a.analysis_id,
            source_experiment: null,
            refs: ["ref1"],
            applicability: "Earlier data-only finding still applies",
          },
        ];
      }
      return reply([
        analyzeCall(null, { candidates: [], candidateUpdates: [] }),
      ]);
    }
    if (i === 2) return reply([trainCall(undefined, evidence)]);
    return reply([finishCall(body)]);
  });
  o.task = { ...obj(o.task), budget: { eda_calls: 2 } };
  const r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  expect((await inspectModeling(r.directory)).manifest.analyses).toHaveLength(
    2,
  );
}, 30000);

for (const method of [
  "no_eda",
  "initial_eda",
  "adaptive_eda",
  "collaborative",
] as const)
  test(`${method} shares training capability and enforces its tool boundary`, async () => {
    const o = await options((body, i) =>
      reply(i === 0 ? [trainCall()] : [finishCall(body)]),
    );
    o.task = { ...obj(o.task), method };
    const r = await runModeling(o);
    expect(r.status, r.reason).toBe("completed");
    const view = await inspectModeling(r.directory);
    expect(view.manifest.usage).toMatchObject({
      eda_calls: method === "initial_eda" ? 1 : 0,
      training_attempts: 2,
    });
    const first = obj((o.client as ScriptClient).bodies[0]);
    const names = (first.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(names.includes("analyze")).toBe(
      method === "adaptive_eda" || method === "collaborative",
    );
    expect(view.knowledge_control).toEqual(
      method === "collaborative"
        ? {
            version: 1,
            history: [],
            applied_sequence: Number(
              obj(view.manifest.candidate_control).applied_sequence,
            ),
          }
        : "disabled",
    );
  }, 30000);

test("initial analysis known failure is not repeated and modeling can still finish", async () => {
  const o = await options((body, i) =>
    reply(i === 0 ? [trainCall()] : [finishCall(body)]),
  );
  o.task = { ...obj(o.task), method: "initial_eda" };
  let analyses = 0;
  o.analysis = async (args) => {
    analyses++;
    return {
      id: args.id,
      run_id: args.runId,
      directory: null,
      dispatch: "not_started",
      effective_budget: args.budget,
      deadline: args.deadline,
      source_experiment: null,
      dataset_hash: args.dataset.files[0]?.sha256 ?? "",
      split_hash: args.dataset.split.sha256,
      protocol_sha256: datasetProtocol(args.dataset).protocol_sha256,
      prediction_sha256: null,
      status: "failed",
      reason: "known preparation failure",
      analysis: null,
      cost: emptyLedger(),
      role_usage: { planner: emptyLedger(), executor: emptyLedger() },
      executions: 0,
      request: args.request,
    };
  };
  const r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  expect(analyses).toBe(1);
  expect((await inspectModeling(r.directory)).manifest.analyses).toHaveLength(
    1,
  );
}, 30000);

for (const fault of ["unknown", "cancel", "timeout", "record"] as const)
  test(`closing ${fault} never selects partial confirmation or resumes the model`, async () => {
    const controller = new AbortController();
    const o = await options((body, i) =>
      reply([i === 0 ? trainCall() : finishCall(body)]),
    );
    o.signal = controller.signal;
    o.task = {
      ...obj(o.task),
      confirmation: { mode: "terminal_repeated_holdout" },
      budget: {
        training_attempts: 6,
        task_timeout_ms: 1200000,
        final_reserve_ms: 750000,
      },
    };
    const execute = o.experiment;
    if (!execute) throw Error("fixture");
    let confirmations = 0,
      finals = 0;
    o.experiment = async (input) => {
      if (input.final) finals++;
      if (input.evaluation?.phase === "confirmation") {
        confirmations++;
        if (fault === "unknown") throw Error("unconfirmed runtime");
        if (fault === "cancel") controller.abort();
        if (fault === "timeout")
          return {
            ...(await execute(input)),
            status: "failed",
            score: null,
            reason: "timeout:closing deadline",
          };
      }
      return execute(input);
    };
    if (fault === "record")
      o.createRecord = async (...args) => {
        const r = await ModelingRecord.create(...args),
          event = r.event.bind(r);
        r.event = async (type, fields, payload) => {
          if (type === "experiment_intent" && fields?.phase === "confirmation")
            throw Error("record_failure:closing intent");
          return event(type, fields, payload);
        };
        return r;
      };
    const r = await runModeling(o);
    expect(r.status).not.toBe("completed");
    expect((o.client as ScriptClient).bodies).toHaveLength(2);
    expect(finals).toBe(0);
    expect(confirmations).toBeLessThanOrEqual(1);
    const view = await inspectModeling(r.directory);
    expect(view.manifest.selected_experiment_id).toBeNull();
    expect(obj(view.manifest.confirmation).status).toBe("incomplete");
    if (fault === "unknown")
      expect(view.unconfirmed_experiments).toHaveLength(1);
    if (fault === "record") expect(r.record_error).toBe(true);
  });

test("deferring the best candidate at finish does not remove its successful pipeline", async () => {
  const o = await options((body, i) =>
    reply([
      i === 0
        ? trainCall()
        : finishCall(body, [updateCandidate("baseline", [], "defer")]),
    ]),
  );
  const r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  const m = (await inspectModeling(r.directory)).manifest;
  expect(m.selected_experiment_id).toBe(m.search_best_experiment_id);
  expect(obj(m.candidate_control).candidates).toMatchObject([
    { id: "baseline", status: "deferred" },
  ]);
});
