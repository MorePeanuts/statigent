import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../../configs/modeling/synthetic-prepare.json";
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
      schema_version: 3,
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
const minimal = {
  code: "def build_pipeline(seed): pass",
  change: "initial",
  reason: "test",
};
test("successful search resets core-error protection and optional warnings do not consume it", async () => {
  const o = await options((body, i) => {
    if (i < 2) return reply([call("run_experiment", { ...minimal, code: 3 })]);
    if (i === 2)
      return reply([
        call("run_experiment", {
          ...minimal,
          notes: {
            text: "unsupported",
            sources: [{ source_id: "analysis:missing:0" }],
          },
        }),
      ]);
    if (i === 3) {
      expect(obj(lastFeedback(body).recovery).consecutive_rejections).toBe(0);
      return reply([call("finish_modeling", { reason: 3 })]);
    }
    return reply([call("finish_modeling", { reason: "done" })]);
  });
  const result = await runModeling(o);
  expect(result.reason).toContain("audit probe");
  expect((o.client as ScriptClient).bodies).toHaveLength(5);
  const view = await inspectModeling(result.directory);
  expect(view.events.filter((e) => e.type === "action_rejected")).toHaveLength(
    3,
  );
  expect(view.manifest.experiments).toHaveLength(2);
});
test("failed execution counts as no progress and cannot reset core-error protection", async () => {
  const o = await options((_body, i) =>
    reply([
      i === 1
        ? call("run_experiment", minimal)
        : call("finish_modeling", { reason: "no model" }),
    ]),
  );
  const base = o.experiment;
  if (!base) throw Error("fixture");
  o.experiment = async (a) => ({
    ...(await base(a)),
    status: "failed",
    score: null,
    reason: "error:code",
  });
  const result = await runModeling(o);
  expect(result.reason).toBe("action_corrections");
  expect((o.client as ScriptClient).bodies).toHaveLength(3);
  expect(
    (await inspectModeling(result.directory)).manifest.experiments,
  ).toHaveLength(1);
});
test("repeated infeasible requests stop without inventing model or analysis results", async () => {
  const o = await options(() =>
    reply([call("analyze", { question: "inspect" })]),
  );
  o.task = { ...obj(o.task), budget: { eda_calls: 0 } };
  const result = await runModeling(o);
  expect(result.reason).toBe("action_corrections");
  expect((o.client as ScriptClient).bodies).toHaveLength(3);
  expect((await inspectModeling(result.directory)).manifest.analyses).toEqual(
    [],
  );
});
test("notes replace without candidate transactions; bad references do not block training or finish", async () => {
  const o = await options((_body, i) =>
    reply([
      i === 0
        ? call("run_experiment", {
            ...minimal,
            notes: {
              text: "small sample",
              sources: [{ source_id: "profile:/rows" }],
            },
          })
        : i === 1
          ? call("run_experiment", {
              ...minimal,
              notes: {
                text: "wrong note",
                sources: [{ source_id: "analysis:invented:0" }],
              },
              sources: [{ source_id: "profile:/rows" }],
            })
          : call("finish_modeling", {
              reason: "finish",
              notes: {
                text: "retain simple model",
                sources: [{ source_id: "profile:/rows" }],
              },
            }),
    ]),
  );
  const result = await runModeling(o);
  expect(result.reason).toContain("audit probe");
  const view = await inspectModeling(result.directory);
  expect(view.manifest.candidate_control).toBeUndefined();
  expect(obj(view.manifest.notes_control).history).toMatchObject([
    { revision: 1, text: "small sample" },
    { revision: 2, text: "retain simple model" },
  ]);
  expect(view.events.filter((e) => e.type === "action_rejected")).toHaveLength(
    0,
  );
  const path = join(result.directory, "modeling.json"),
    text = await readFile(path, "utf8"),
    value = obj(JSON.parse(text));
  obj((obj(value.notes_control).history as unknown[])[0]).text = "tampered";
  await writeFile(path, JSON.stringify(value));
  await expect(inspectModeling(result.directory)).rejects.toThrow(
    "Notes snapshot",
  );
  await writeFile(path, text);
});
test("invalid core repair refuses its note update and dispatches no experiment", async () => {
  const o = await options(() =>
    reply([
      call("run_experiment", {
        ...minimal,
        repair_of_experiment: "missing",
        notes: { text: "must not apply" },
      }),
    ]),
  );
  const result = await runModeling(o),
    view = await inspectModeling(result.directory);
  expect(result.reason).toBe("action_corrections");
  expect(view.manifest.experiments).toEqual([]);
  expect(obj(view.manifest.notes_control).history).toEqual([]);
});
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
              ? args.code === linearCode
                ? 1
                : 10
              : args.code === linearCode
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
