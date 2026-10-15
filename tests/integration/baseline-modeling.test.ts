import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineAdapter } from "../../src/baselines/adapter";
import { reproduceBaseline } from "../../src/baselines/reproduce";
import { readPredictionManifest } from "../../src/evaluation/predictions";
import { reply, ScriptClient } from "../helpers/agent";
import { modelingInvocation } from "../helpers/evaluation-modeling";

const entry = `import argparse,json,pickle
from pathlib import Path
import pandas as pd
p=argparse.ArgumentParser()
for k in ('features','output','schema'): p.add_argument('--'+k,required=True)
a=p.parse_args(); protocol=json.loads(Path(a.schema).read_text())['protocol']
assert not Path('/input/data/search/train.csv').exists()
x=pd.read_csv(a.features,dtype=str,keep_default_na=False)
models=pickle.loads(Path('models.pkl').read_bytes())
result={protocol['id_column']: x[protocol['id_column']]}
for model,target,spec in zip(models,protocol['targets'],protocol['prediction']['targets']):
    proba=model.predict_proba(x[protocol['feature_columns']])
    if spec['value_column']: result[spec['value_column']]=model.predict(x[protocol['feature_columns']])
    for i,c in enumerate(spec['probability_columns']): result[c]=proba[:,list(model.classes_).index(target['classes'][i])]
pd.DataFrame(result).to_csv(a.output,index=False)
`;
for (const method of ["react", "autogen", "datawiseagent"] as const) {
  test(`${method} freezes explicitly fitted multi-target bundle before independent prediction`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), `baseline-model-${method}-`)),
    );
    try {
      const i = await modelingInvocation(root);
      i.config.adapter = method;
      i.config.id = method;
      i.config.options = {
        schema_version: 1,
        method,
        image: "statigent-runtime:baselines-cpu-v1",
        delivery_reserve_ms: 30000,
      };
      i.budget = {
        timeout_ms: 120000,
        model_attempts: 10,
        total_tokens: 150000,
      };
      const code = `from pathlib import Path\nimport json,pickle,pandas as pd\nfrom sklearn.dummy import DummyClassifier\nassert not Path('/input/data/final-prediction/test.csv').exists()\nassert not Path('/input/data/evaluator/labels.csv').exists()\nm=json.loads(Path('/input/data/dataset.json').read_text()); p=m['protocol']\nx=pd.read_csv('/input/data/search/train.csv',dtype=str,keep_default_na=False)\nmodels=[DummyClassifier(strategy='prior').fit(x[p['feature_columns']],x[t['name']]) for t in p['targets']]\nb=Path('/tmp/baseline-models/selected');b.mkdir(parents=True)\n(b/'models.pkl').write_bytes(pickle.dumps(models))\n(b/'predict.py').write_text(${JSON.stringify(entry)})`;
      const done = {
        kind: "predictions",
        bundle: "selected",
        entrypoint: "predict.py",
      };
      const responses =
        method === "react"
          ? [
              JSON.stringify({ action: "execute", code }),
              JSON.stringify({ action: "finish", submission: done }),
            ]
          : method === "autogen"
            ? [
                `\`\`\`python\n${code}\n\`\`\``,
                `STATIGENT_FINAL\n${JSON.stringify(done)}`,
              ]
            : [
                "```markdown\n[STEP GOAL] Fit models\n```",
                `\`\`\`python\n${code}\n\`\`\`\n<end_step>`,
                `\`\`\`markdown\nSTATIGENT_FINAL\n${JSON.stringify(done)}\n\`\`\`\n<Fulfill USER INSTRUCTION>`,
              ];
      const client = new ScriptClient((_body, index) =>
        reply([], {
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: responses[index] ?? "Unexpected call",
                reasoning_content: `reason-${index}`,
              },
            },
          ],
        }),
      );
      const result = await baselineAdapter(method, { client }).run(
        i,
        new AbortController().signal,
      );
      expect(result.reason).toBe("explicit_submission");
      expect(result.status).toBe("completed");
      expect(result.native_run).toBeNull();
      expect(result.usage.attempts).toBe(responses.length);
      const manifest = await readPredictionManifest(
        i.deliverables_root,
        i.task,
        { seed: i.seed, exported: false },
      );
      expect(manifest.producer?.method).toBe(method);
      expect(manifest.workflow.confirmation).toBe("not_applicable");
      expect(manifest.native_model).toBeNull();
      const prediction = await readFile(
        join(i.deliverables_root, "predictions.csv"),
        "utf8",
      );
      expect(prediction).toContain("test:0");
      const run = join(i.run_root, (await readdir(i.run_root))[0] ?? "missing");
      expect(
        JSON.parse(
          await readFile(join(run, "prediction/prediction.json"), "utf8"),
        ).calls,
      ).toEqual({ models: 0, fits: 0 });
      if (method === "react") {
        const replay = await reproduceBaseline(
          run,
          join(root, "replay"),
          45000,
          new AbortController().signal,
        );
        expect(replay.status).toBe("passed");
        expect(replay.calls).toEqual({ models: 0, fits: 0 });
      }
    } finally {
      const runRoot = join(root, "native");
      for (const run of await readdir(runRoot)) {
        const files = join(runRoot, run, "bundle/files");
        if (await Bun.file(join(files, "predict.py")).exists())
          await chmod(files, 0o755);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 180000);
}
