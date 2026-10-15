import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeContainerBundle } from "../../src/baselines/bundle";
import { baselineExecution } from "../../src/baselines/execution";
import { predictBundle } from "../../src/baselines/predict";
import { inspectImage } from "../../src/evaluation/agents/docker";
import { describeFile } from "../../src/evaluation/files";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";
import { DEFAULT_DATA_LIMITS } from "../../src/modeling/data-limits";
import { createProtocolV2 } from "../../src/modeling/protocol-v2";

const predictionEntry = `import argparse, json, pickle
from pathlib import Path
import pandas as pd
p = argparse.ArgumentParser()
for key in ('features','output','schema'): p.add_argument('--'+key, required=True)
a=p.parse_args()
assert sorted(x.name for x in Path('/input').iterdir()) == ['features.csv','schema.json']
assert not Path('/input/train.csv').exists()
assert not Path('/workspace/secret.txt').exists()
schema=json.loads(Path(a.schema).read_text())['protocol']
x=pd.read_csv(a.features)
with open('model.pkl','rb') as f: model=pickle.load(f)
y=model.predict(x[schema['feature_columns']])
pd.DataFrame({schema['id_column']: x[schema['id_column']], schema['prediction']['targets'][0]['value_column']: y}).to_csv(a.output,index=False)
`;

test("frozen fitted model predicts in a fresh container without training state or LLM", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-predict-")),
  );
  await mkdir(join(root, "train"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "train/train.csv"), "x,y\n1,2\n2,4\n3,6\n");
  await writeFile(join(root, "test/features.csv"), "id,x\na,4\nb,5\n");
  const image = await inspectImage("statigent-runtime:baselines-cpu-v1");
  const execution = await baselineExecution({
    config: {
      run_id: "baseline-fit",
      image: String(image.image_id),
      backend: "persistent-kernel",
      input_root: join(root, "train"),
      inputs: ["train.csv"],
      staging_root: join(root, "staging"),
      seed: 7,
      limits: { ...DEFAULT_LIMITS, task_timeout_ms: 60000 },
    },
    artifactDirectory: join(root, "artifacts"),
    event: async () => {},
  });
  try {
    const code = `import pandas as pd, pickle\nfrom pathlib import Path\nfrom sklearn.linear_model import LinearRegression\nx=pd.read_csv('/input/train.csv')\nm=LinearRegression().fit(x[['x']],x.y)\np=Path('/tmp/baseline-models/selected'); p.mkdir(parents=True)\n(p/'model.pkl').write_bytes(pickle.dumps(m))\n(p/'predict.py').write_text(${JSON.stringify(predictionEntry)})\nPath('/workspace/secret.txt').write_text('search only')`;
    expect(
      (await execution.execute(code, "fit", new AbortController().signal))
        .status,
    ).toBe("ok");
    execution.seal();
    await expect(
      execution.execute("print(1)", "late", new AbortController().signal),
    ).rejects.toThrow();
    const bundle = await freezeContainerBundle({
      container: execution.session.containerName,
      bundle: "selected",
      entrypoint: "predict.py",
      destination: join(root, "bundle"),
      image: String(image.image_id),
      platform: String(image.platform),
      maxFiles: 100,
      maxBytes: 1048576,
      signal: new AbortController().signal,
      timeout_ms: 30000,
      stop: () => execution.closeAfterSnapshot(),
    });
    const protocol = createProtocolV2({
      kind: "regression",
      metric_id: "rmse-v1",
      id_column: "id",
      feature_columns: ["x"],
      targets: [{ name: "y", classes: [], positive_class: null, levels: null }],
    });
    for (const attempt of [1, 2]) {
      const result = await predictBundle({
        bundleRoot: bundle.root,
        bundle: bundle.manifest,
        featuresRoot: join(root, "test"),
        features: await describeFile(join(root, "test"), "features.csv"),
        protocol,
        limits: { ...DEFAULT_DATA_LIMITS, max_file_bytes: 1048576 },
        seed: 7,
        directory: join(root, `predict-${attempt}`),
        timeout_ms: 30000,
        cpus: 2,
        memory_bytes: 2 * 1024 ** 3,
        signal: new AbortController().signal,
      });
      expect(result.record.audit.common_fit_calls).toBe(0);
      expect(result.record.validation.rows).toBe(2);
      const rows = (await readFile(result.path, "utf8")).trim().split("\n");
      expect(Number(rows[1]?.split(",")[1])).toBeCloseTo(8, 10);
    }
    expect(
      await readFile(join(root, "predict-1/predictions.csv"), "utf8"),
    ).toBe(await readFile(join(root, "predict-2/predictions.csv"), "utf8"));
  } finally {
    await execution.close();
    if (await Bun.file(join(root, "bundle/files/predict.py")).exists())
      await chmod(join(root, "bundle/files"), 0o755);
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
