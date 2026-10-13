import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeFile } from "../../src/evaluation/files";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { modelingPrompt, modelingTools } from "../../src/modeling/actions";
import { csv, parseCsv } from "../../src/modeling/data";
import { loadDatasetV3 } from "../../src/modeling/dataset-v3";
import { prepareAnalysisInputV2 } from "../../src/modeling/eda-v2";
import type { Experiment, StageResult } from "../../src/modeling/experiments";
import { createBasicProfileV2 } from "../../src/modeling/profile-v2";
import { predictionColumnsV2 } from "../../src/modeling/protocol-v2";
import type { ScoreV2 } from "../../src/modeling/score-v2";
import { evaluation } from "../../src/modeling/validation";
import { loadSearchMembersV2 } from "../../src/modeling/validation-v2";
import { bindSource } from "../../src/modeling/workflow";
import { sha256 } from "../../src/records/store";

test("multi-target EDA preserves every target, phase and source through explore/diagnose/compare", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eda-v2-")));
  try {
    const sourceRoot = join(root, "data");
    await command(
      [
        "uv",
        "run",
        "--offline",
        "--frozen",
        "--no-sync",
        "python",
        "-c",
        "from pathlib import Path; import sys; from test_modeling_dataset_v3 import prepare; prepare(Path(sys.argv[1]))",
        sourceRoot,
      ],
      {
        timeout_ms: 10000,
        env: {
          ...commandEnvironment(),
          PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
        },
      },
    );
    const { dataset } = await loadDatasetV3(sourceRoot),
      p = dataset.protocol;
    const members = await loadSearchMembersV2(sourceRoot, dataset);
    const e = evaluation(dataset, "search", members, dataset.seed);
    const score = (id: string, partition: ScoreV2["partition"]): ScoreV2 => ({
      metric: p.metric.id,
      direction: p.metric.direction,
      value: 0.5,
      protocol_sha256: p.protocol_sha256,
      scoring_version: p.scoring_version,
      metric_definition_sha256: p.metric.definition_sha256,
      evaluation_id: id,
      partition,
      components: p.targets.map((t) => ({
        target: t.name,
        metric: "roc-auc-v1",
        value: 0.5,
        error: null,
      })),
    });
    const stage = async (name: string, ids: string[]): Promise<StageResult> => {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(
        join(directory, "predictions.csv"),
        csv({
          columns: predictionColumnsV2(p),
          rows: [...ids]
            .reverse()
            .map((id) => [
              id,
              ...p.targets.flatMap((t) => [t.classes[0] ?? "", "0.5", "0.5"]),
            ]),
        }),
      );
      return {
        run_id: name,
        directory,
        status: "completed",
        reason: "ok",
        output: await describeFile(directory, "predictions.csv"),
        image: { id: "synthetic", platform: "synthetic" },
        elapsed_ms: 0,
        execution_confirmed: true,
      };
    };
    const predict = await stage("validation", members.validation),
      training = await stage("training", members.train);
    const memberHash = sha256(Buffer.from(JSON.stringify(members.train)));
    const diagnosticId = sha256(
      Buffer.from(
        JSON.stringify({
          partition: "train",
          search_evaluation_id: e.evaluation_id,
          members_sha256: memberHash,
        }),
      ),
    );
    const experiment: Experiment<ScoreV2> = {
      id: "search1",
      candidate_id: "fixed",
      code: "fixture",
      code_sha256: sha256(Buffer.from("fixture")),
      status: "completed",
      reason: "ok",
      score: score(e.evaluation_id, "search-validation"),
      fit: predict,
      predict,
      final: false,
      phase: "search",
      evaluation: e,
      training_diagnostic: {
        partition: "train",
        status: "available",
        members_sha256: memberHash,
        model_sha256: predict.output?.sha256 ?? "",
        prediction: training,
        score: score(diagnosticId, "search-training"),
        reason: "ok",
        elapsed_ms: 0,
      },
    };
    const common = {
      sourceRoot,
      workRoot: root,
      dataset,
      members,
      context: {},
      signal: new AbortController().signal,
      remaining: () => 10000,
    };
    for (const [purpose, experiments] of [
      ["explore", []],
      ["diagnose", [experiment]],
      ["compare", [experiment, { ...experiment, id: "search2" }]],
    ] as const) {
      const input = join(root, purpose);
      const inputs = await prepareAnalysisInputV2({
        ...common,
        root: input,
        experiments,
      });
      expect(
        inputs.some((name) =>
          /test|evaluator|source-rows|model.joblib/.test(name),
        ),
      ).toBe(false);
      const source = await Bun.file(join(input, "source.json")).json();
      expect(source.targets).toEqual(p.targets);
      expect(source.sources).toHaveLength(experiments.length);
      expect(source.protocol).toEqual(p);
      const table = parseCsv(await Bun.file(join(input, "train.csv")).text());
      expect(table.columns).toEqual([
        p.id_column,
        ...p.feature_columns,
        ...p.targets.map((t) => t.name),
      ]);
      expect(
        table.rows.every(
          (r) =>
            members.train.includes(r[0] ?? "") ||
            members.validation.includes(r[0] ?? ""),
        ),
      ).toBe(true);
      for (const origin of source.sources) {
        expect(origin.fields).toEqual(p.prediction);
        expect(origin.training.score.partition).toBe("search-training");
        expect(origin.score.partition).toBe("search-validation");
      }
    }
    const profile = await createBasicProfileV2({
      root,
      sourceRoot,
      dataset,
      members,
      timeout_ms: 10000,
    });
    const context = {
      run_id: "parent",
      profile: profile.profile,
      profile_sha256: profile.artifact.sha256,
      protocol: p,
      experiments: [experiment],
      analyses: [],
    };
    expect(
      bindSource({ source_id: "profile:/targets/1/classes" }, context).binding
        .protocol_sha256,
    ).toBe(p.protocol_sha256);
    expect(
      bindSource({ source_id: "experiment:search1:train_diagnostic" }, context)
        .binding.partition,
    ).toBe("train");
    expect(() =>
      bindSource(
        { source_id: "experiment:search1:score" },
        {
          ...context,
          experiments: [
            { ...experiment, score: score(e.evaluation_id, "test") },
          ],
        },
      ),
    ).toThrow("partition");
    await expect(
      prepareAnalysisInputV2({
        ...common,
        root: join(root, "bad-target"),
        experiments: [
          {
            ...experiment,
            score: {
              ...score(e.evaluation_id, "search-validation"),
              components: [],
            },
          },
        ],
      }),
    ).rejects.toThrow("components");
    for (const method of [
      "no_eda",
      "initial_eda",
      "adaptive_eda",
      "collaborative",
    ] as const) {
      const tools = modelingTools(p, method);
      expect(tools.map((t) => t.function.name)).toEqual(
        method === "no_eda" || method === "initial_eda"
          ? ["run_experiment", "finish_modeling"]
          : ["run_experiment", "analyze", "finish_modeling"],
      );
      expect(
        tools.every((t) =>
          t.function.description.includes("mean-target-auc-v1"),
        ),
      ).toBe(true);
      expect(modelingPrompt(method, 2)).toContain("ALL target names");
      expect(modelingPrompt(method, 2)).toContain("class indices");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
