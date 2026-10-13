import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
import { action } from "../../src/modeling/actions";
import { prepareDataset } from "../../src/modeling/data";
import { validateEvidence } from "../../src/modeling/eda";
import { inspectModeling } from "../../src/modeling/records";
import { type ModelingOptions, runModeling } from "../../src/modeling/run";
import { ModelFailure, normalizeUsage } from "../../src/models/client";
import { obj } from "../../src/models/validation";
import { emptyLedger } from "../../src/records/agent-metadata";
import { sha256 } from "../../src/records/store";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { baselineCode, modelingScript, trainCall } from "../helpers/modeling";

async function options(
  script: ConstructorParameters<typeof ScriptClient>[0],
): Promise<ModelingOptions> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "modeling-loop-"));
  await prepareDataset(source, join(root, "data"));
  let count = 0;
  return {
    task: {
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
      rmse: o.final ? null : ++count,
      fit: null,
      predict: null,
      final: o.final ?? false,
    }),
    analysis: async (o) => ({
      id: o.id,
      run_id: o.runId,
      directory: join(root, o.runId),
      source_experiment: o.request.source_experiment,
      dataset_hash: o.dataset.files[0]?.sha256 ?? "",
      split_hash: o.dataset.split.sha256,
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
    }),
    delivery: async (_root, task, selected, final, dataset) => ({
      schema_version: 1,
      source_experiment: selected.id,
      dataset,
      model_environment: {},
      code_version: { commit: null, dirty: null },
      validation_rmse: selected.rmse,
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
          ? [call("finish_modeling", { experiment_id: "fake", reason: "fake" })]
          : i === 2
            ? [trainCall()]
            : [
                call("finish_modeling", {
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
  o.analysis = async (input) => ({
    ...(await original(input)),
    cost: {
      ...emptyLedger(),
      status: "unknown",
      attempts: 1,
      unknown_attempts: 1,
    },
  });
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
            experiment_id: lastFeedback(body).best_experiment_id,
            reason: "done",
          }),
    ]);
  const o = await options(direct);
  o.task = { ...obj(o.task), budget: { final_training_attempts: 2 } };
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

test("a failed training attempt can be explicitly referenced by its bounded repair", async () => {
  const o = await options((body, i) =>
    reply([
      i === 0
        ? trainCall()
        : i === 1
          ? trainCall(
              baselineCode,
              [],
              String(obj(lastFeedback(body).result).experiment_id),
            )
          : call("finish_modeling", {
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
      ? { ...e, status: "failed", reason: "error:bad candidate", rmse: null }
      : e;
  };
  const r = await runModeling(o);
  expect(r.status, r.reason).toBe("completed");
  expect(attempts).toBe(3);
});
