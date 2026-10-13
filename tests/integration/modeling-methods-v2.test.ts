import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { inspectModeling } from "../../src/modeling/records";
import { runModeling } from "../../src/modeling/run";
import { obj } from "../../src/models/validation";
import {
  call,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { returned } from "../helpers/collaboration";

test("four native methods share all 150 features and both targets through real EDA modes", async () => {
  const root = resolve("runs/integration-modeling-methods-v2", randomUUID());
  await mkdir(root, { recursive: true });
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
      `
from pathlib import Path
import sys
from test_modeling_dataset_v3 import prepare
features=[dict(name="f"+str(i),kind="numeric",source_type="synthetic",categories=None) for i in range(150)]
rows=[("train:"+str(i),i,{**{"f"+str(j):i for j in range(150)},"EC1":str(i%2),"EC2":str(i%2)}) for i in range(40)]
prepare(Path(sys.argv[1]),features=features,train=rows,prediction=None,labels=None,explicit_split=None)
`,
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
  const profiles: unknown[] = [];
  for (const method of [
    "no_eda",
    "initial_eda",
    "adaptive_eda",
    "collaborative",
  ] as const) {
    const origins: string[] = [];
    const train = (depth: number) =>
      call("run_experiment", {
        change: `depth ${depth}`,
        reason: "fixed synthetic test",
        code: `from sklearn.multioutput import MultiOutputClassifier\nfrom sklearn.tree import DecisionTreeClassifier\ndef build_pipeline(seed):\n    return MultiOutputClassifier(DecisionTreeClassifier(max_depth=${depth},random_state=seed))\n`,
        ...(method === "collaborative"
          ? {
              notes: {
                text: "Consider every target independently",
                sources: [{ source_id: "profile:/targets/1/classes" }],
              },
            }
          : {}),
      });
    const client = new ScriptClient((body, index) => {
      if (index === 0) return reply([train(2)]);
      const feedback = obj(lastFeedback(body).result);
      if (typeof feedback.experiment_id === "string")
        origins.push(feedback.experiment_id);
      if (method === "collaborative" && index === 1) return reply([train(3)]);
      if (
        (method === "adaptive_eda" && index === 1) ||
        (method === "collaborative" && index === 2)
      )
        return reply([
          call("analyze", {
            question: "Inspect all target predictions",
            source_experiments: origins,
          }),
        ]);
      return reply([
        call("finish_modeling", { reason: "fixed acceptance complete" }),
      ]);
    });
    let evidence = "";
    const eda = new ScriptClient((body, index) => {
      if (index === 0)
        return reply([
          call("delegate_analysis", {
            task: "Inspect every feature and target from source.json",
            constraints: [],
          }),
        ]);
      if (index === 1)
        return reply([
          call("execute_python", {
            code: `import json
from pathlib import Path
import pandas as pd
s=json.loads(Path('/input/source.json').read_text())
assert s['version']==3
assert [t['name'] for t in s['targets']]==['EC1','EC2']
assert len(s['protocol']['feature_columns'])==150
d=pd.read_csv('/input/train.csv')
assert len(d.columns)==153
assert len(s['sources'])==${method === "initial_eda" ? 0 : method === "adaptive_eda" ? 1 : 2}
assert not any('test' in p.name or 'evaluator' in p.name for p in Path('/input').iterdir())
for origin in s['sources']:
    assert [t['target'] for t in origin['fields']['targets']]==['EC1','EC2']
    assert origin['score']['partition']=='search-validation'
    assert origin['training']['score']['partition']=='search-training'
    predictions=pd.read_csv('/input/'+origin['predictions']['path'])
    assert len(predictions.columns)==7
print({'features':150,'targets':['EC1','EC2'],'sources':len(s['sources'])})
`,
          }),
        ]);
      if (index === 2) {
        evidence = String(lastFeedback(body).cell_id);
        return reply([returned(body, [evidence])]);
      }
      return reply([
        call("finish_analysis", {
          summary: "All allowed features and targets inspected",
          findings: [
            {
              statement: "All 150 features and both targets are present",
              evidence_refs: [evidence],
            },
          ],
          methods: [
            "Read only whitelisted files and verified all target metadata",
          ],
          limitations: ["Synthetic task; no performance claim"],
        }),
      ]);
    });
    const result = await runModeling({
      task: {
        schema_version: 4,
        delivery_mode: "fit_only",
        method,
        confirmation: { mode: "none" },
        resource_version: "wide-multi-v2",
        goal: "Test full-target handoff",
        dataset_root: sourceRoot,
        model_profile: profile.id,
        image: "statigent-runtime:modeling-benchmarks",
      },
      profile,
      edaProfile: profile,
      client,
      edaClient: eda,
      runRoot: join(root, method),
    });
    expect(result.status, `${method}: ${result.reason}`).toBe("model_frozen");
    const view = await inspectModeling(result.directory),
      basic = obj(obj(view.manifest.basic_profile).profile);
    expect(view.unconfirmed_children).toHaveLength(0);
    expect(basic.column_count).toBe(153);
    expect(basic.omitted_columns).toBe(25);
    profiles.push(basic);
    const analyses = view.manifest.analyses;
    if (!Array.isArray(analyses)) throw new Error("Missing analyses");
    expect(analyses).toHaveLength(method === "no_eda" ? 0 : 1);
    if (method !== "no_eda") {
      expect(obj(analyses[0]).status).toBe("completed");
      expect(obj(obj(analyses[0]).request).purpose).toBe(
        method === "initial_eda"
          ? "explore"
          : method === "adaptive_eda"
            ? "diagnose"
            : "compare",
      );
      expect(eda.bodies).toHaveLength(4);
    }
  }
  expect(
    profiles.every((p) => JSON.stringify(p) === JSON.stringify(profiles[0])),
  ).toBe(true);
}, 300000);
