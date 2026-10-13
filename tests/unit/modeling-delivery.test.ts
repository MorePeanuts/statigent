import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import { describeFile } from "../../src/evaluation/files";
import { validateModelingTask } from "../../src/modeling/config";
import { datasetProtocol, prepareDataset } from "../../src/modeling/data";
import { scoreDelivery } from "../../src/modeling/delivery";

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "class-delivery-")),
    directory = join(root, "parent"),
    delivery = join(directory, "delivery");
  await mkdir(delivery, { recursive: true });
  const dataset = await prepareDataset(binary, join(root, "data")),
    protocol = datasetProtocol(dataset);
  const paths = [
    "candidate.py",
    "model.joblib",
    "predictions.csv",
    "train.py",
    "predict.py",
    "model-metadata.json",
    "README.md",
  ];
  for (const p of paths)
    await writeFile(
      join(delivery, p),
      p === "model-metadata.json"
        ? JSON.stringify({ schema_version: 1, protocol })
        : "fixture",
    );
  const manifest = {
    schema_version: 2,
    dataset,
    protocol,
    validation_score: {
      metric: protocol.metric,
      direction: protocol.direction,
      value: 0.5,
      protocol_sha256: protocol.protocol_sha256,
      scoring_version: protocol.scoring_version,
    },
    files: await Promise.all(paths.map((p) => describeFile(delivery, p))),
    task: validateModelingTask({
      goal: "test",
      dataset_root: join(root, "data"),
      model_profile: "test",
      image: "fixture",
    }),
    prediction_tolerance: { atol: 1e-8, rtol: 1e-6 },
  };
  const parent = {
    schema_version: 2,
    kind: "modeling",
    status: "completed",
    config: { dataset, protocol },
    delivery: manifest,
  };
  const save = async () => {
    await writeFile(join(directory, "modeling.json"), JSON.stringify(parent));
    await writeFile(join(delivery, "delivery.json"), JSON.stringify(manifest));
  };
  await save();
  return { root, directory, delivery, manifest, parent, save };
}
test("delivery rejects missing metadata, mismatched protocol, changed bytes and altered comparison tolerance before scoring", async () => {
  for (const mode of [
    "missing",
    "protocol",
    "tamper",
    "tolerance",
    "version",
    "metadata",
  ]) {
    const o = await fixture();
    const before = await readFile(join(o.directory, "modeling.json"), "utf8");
    if (mode === "metadata") {
      await writeFile(
        join(o.delivery, "model-metadata.json"),
        JSON.stringify({ schema_version: 99, protocol: o.manifest.protocol }),
      );
      o.manifest.files = await Promise.all(
        o.manifest.files.map((f) => describeFile(o.delivery, f.path)),
      );
      await o.save();
    }
    if (mode === "missing")
      await unlink(join(o.delivery, "model-metadata.json"));
    if (mode === "protocol") {
      o.manifest.protocol = {
        ...o.manifest.protocol,
        protocol_sha256: "b".repeat(64),
      };
      await o.save();
    }
    if (mode === "tamper")
      await writeFile(join(o.delivery, "model.joblib"), "changed");
    if (mode === "tolerance") {
      o.manifest.prediction_tolerance.atol = 1;
      await o.save();
    }
    if (mode === "version") {
      o.manifest.schema_version = 3;
      await o.save();
    }
    await expect(
      scoreDelivery(o.directory, o.root, "labels.csv", join(o.root, "score")),
    ).rejects.toThrow();
    if (mode === "missing" || mode === "tamper")
      expect(await readFile(join(o.directory, "modeling.json"), "utf8")).toBe(
        before,
      );
  }
});
