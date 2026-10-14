import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  modelingTaskFromPrepared,
  nativeModelingPublication,
} from "../../src/evaluation/benchmarks/modeling/publication";
import {
  INPUT_PHASES,
  validateInvocation,
} from "../../src/evaluation/contracts";
import {
  describeFile,
  publishInputs,
  publishTaskInputs,
  verifyFiles,
} from "../../src/evaluation/files";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { deterministicPipeline } from "../../src/modeling/deterministic";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { returned } from "../helpers/collaboration";

test("phased evaluation hides test features and private files through search, EDA and confirmation", async () => {
  const root = resolve("runs/evaluation-modeling-isolation", randomUUID());
  await mkdir(root, { recursive: true });
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
      join(root, "data"),
    ],
    {
      timeout_ms: 10000,
      env: {
        ...commandEnvironment(),
        PYTHONPATH: `${resolve("python")}:${resolve("tests/python")}`,
      },
    },
  );
  const task = await modelingTaskFromPrepared(
    root,
    "data",
    "probe",
    "Verify phase isolation",
  );
  const sourceRefs = await Promise.all(
    [
      "data/dataset.json",
      "data/search/train.csv",
      "data/final-prediction/test.csv",
      "data/evaluator/labels.csv",
    ].map((path) => describeFile(root, path)),
  );
  await expect(
    publishInputs(root, task, join(root, "invalid-input")),
  ).rejects.toThrow("phase");
  const inputRoot = join(root, "input"),
    published = await publishTaskInputs(root, task, inputRoot);
  if (!published.phase_roots) throw new Error("Missing phase roots");
  for (const phase of INPUT_PHASES) {
    expect(
      await Bun.file(
        join(published.phase_roots[phase], "data/evaluator/labels.csv"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(published.phase_roots[phase], "data/final-prediction/test.csv"),
      ).exists(),
    ).toBe(phase === "prediction");
  }
  const invocation = validateInvocation({
    schema_version: 3,
    evaluation_id: "probe",
    unit_id: "unit-1",
    task,
    config: {
      id: "probe",
      adapter: "statigent-modeling",
      options: {},
      model: profile,
      require_seed: true,
    },
    budget: { timeout_ms: 900000, model_attempts: 40, total_tokens: 600000 },
    seed: 42,
    input_root: inputRoot,
    phase_roots: published.phase_roots,
    run_root: join(root, "native"),
    deliverables_root: join(root, "deliverables"),
    trajectory: false,
  });
  const publication = await nativeModelingPublication(invocation);
  const predictionPath = join(publication.root, "final-prediction/test.csv");
  const probe = `import os, csv
from pathlib import Path
assert os.environ.get('STATIGENT_ISOLATION_SENTINEL') is None
assert not Path(${JSON.stringify(root)}).exists()
assert not Path('/Users').exists()
assert not Path('/input/evaluator').exists()
assert not Path('/input/final-prediction').exists()
`;
  const code =
    probe +
    deterministicPipeline(publication.dataset.protocol).replace(
      "def build_pipeline(seed):",
      `def build_pipeline(seed):
    with open('/input/data.csv') as stream:
        assert all(row[${JSON.stringify(publication.dataset.protocol.id_column)}].startswith('train:') for row in csv.DictReader(stream))`,
    );
  const client = new ScriptClient(async (_body, index) => {
    expect(await Bun.file(predictionPath).exists()).toBe(false);
    if (index === 0)
      return reply([
        call("run_experiment", {
          code,
          change: "fixed isolation probe",
          reason: "verify training scope",
        }),
      ]);
    if (index === 1)
      return reply([
        call("finish_modeling", { reason: "verification complete" }),
      ]);
    throw new Error("Unexpected later decisions");
  });
  let evidence = "";
  const eda = new ScriptClient((body, index) => {
    if (index === 0)
      return reply([
        call("delegate_analysis", {
          task: "Inspect allowed training inputs",
          constraints: [],
        }),
      ]);
    if (index === 1)
      return reply([
        call("execute_python", {
          code: `${probe}
assert not any('test' in p.name or 'evaluator' in p.name for p in Path('/input').iterdir())
with open('/input/train.csv') as stream:
    assert all(row['sample_id'].startswith('train:') for row in csv.DictReader(stream))
print('phase isolation verified')`,
        }),
      ]);
    if (index === 2) {
      evidence = String(lastFeedback(body).cell_id);
      return reply([returned(body, [evidence])]);
    }
    return reply([
      call("finish_analysis", {
        summary: "Training scope verified",
        findings: [
          {
            statement: "Only allowed training data is visible",
            evidence_refs: [evidence],
          },
        ],
        methods: ["Checked mounted files and environment"],
        limitations: ["Synthetic isolation probe"],
      }),
    ]);
  });
  const prior = process.env.STATIGENT_ISOLATION_SENTINEL;
  process.env.STATIGENT_ISOLATION_SENTINEL = "host-only-probe";
  let released = false;
  try {
    const result = await runModeling({
      task: {
        schema_version: 4,
        delivery_mode: "fit_predict",
        method: "initial_eda",
        confirmation: { mode: "terminal_repeated_holdout" },
        resource_version: "phase-isolation-v1",
        goal: task.goal,
        dataset_root: publication.root,
        model_profile: profile.id,
        image: "statigent-runtime:modeling-benchmarks",
        budget: { training_attempts: 6, final_reserve_ms: 750000 },
      },
      profile,
      edaProfile: profile,
      client,
      edaClient: eda,
      runRoot: invocation.run_root,
      benchmark: {
        inputAccess: "training",
        publishPrediction: async () => {
          expect(await Bun.file(predictionPath).exists()).toBe(false);
          expect(client.bodies).toHaveLength(2);
          const frozen = Array.from(
            new Bun.Glob("*/frozen/model.json").scanSync(invocation.run_root),
          );
          expect(frozen).toHaveLength(1);
          await publication.publishPrediction();
          released = true;
        },
      },
    });
    expect(result.status, result.reason).toBe("completed");
    expect(released).toBe(true);
    expect(eda.bodies).toHaveLength(4);
    const view = await inspectModeling(result.directory);
    expect(view.unconfirmed_children).toHaveLength(0);
    expect(view.unconfirmed_experiments).toHaveLength(0);
    expect(
      await Bun.file(join(publication.root, "evaluator/labels.csv")).exists(),
    ).toBe(false);
    await expect(publication.publishPrediction()).rejects.toThrow("once");
    await verifyFiles(root, sourceRefs);
  } finally {
    if (prior === undefined) delete process.env.STATIGENT_ISOLATION_SENTINEL;
    else process.env.STATIGENT_ISOLATION_SENTINEL = prior;
  }
}, 180000);
