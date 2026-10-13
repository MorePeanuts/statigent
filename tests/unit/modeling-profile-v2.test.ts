import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command, commandEnvironment } from "../../src/evaluation/process";
import { loadDatasetV3 } from "../../src/modeling/dataset-v3";
import {
  type BasicProfileV2,
  createBasicProfileV2,
  validateBasicProfileV2,
} from "../../src/modeling/profile-v2";
import { loadSearchMembersV2 } from "../../src/modeling/validation-v2";

test("wide V2 profile keeps full schema and yields identical facts for all four methods", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "wide-profile-v2-")),
  );
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
        `
from pathlib import Path
import sys
from test_modeling_dataset_v3 import prepare
features=[dict(name="f"+str(i),kind="numeric",source_type="synthetic",categories=None) for i in range(150)]
rows=[("train:"+str(i),i,{**{"f"+str(j):i for j in range(150)},"EC1":str(i%2),"EC2":str(i%2)}) for i in range(20)]
prepare(Path(sys.argv[1]),features=features,train=rows,prediction=None,labels=None)
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
    const { dataset } = await loadDatasetV3(sourceRoot),
      members = await loadSearchMembersV2(sourceRoot, dataset);
    const profiles: BasicProfileV2[] = [];
    for (const method of [
      "no_eda",
      "initial_eda",
      "adaptive_eda",
      "collaborative",
    ]) {
      const run = join(root, method);
      await mkdir(run);
      const profile = await createBasicProfileV2({
        root: run,
        sourceRoot,
        dataset,
        members,
        timeout_ms: 10000,
      });
      profiles.push(profile.profile);
      expect(profile.profile.column_count).toBe(153);
      expect(profile.profile.columns).toHaveLength(128);
      expect(profile.profile.omitted_columns).toBe(25);
      const full = await Bun.file(
        join(run, "basic-profile/features.json"),
      ).json();
      expect(full.columns).toHaveLength(150);
      expect(profile.schema_artifact.sha256).toBe(
        dataset.feature_schema.sha256,
      );
      expect(() =>
        validateBasicProfileV2(
          { ...profile.profile, omitted_columns: 0 },
          dataset,
          members,
          profile.profile.identity.snapshot_sha256,
        ),
      ).toThrow("truncation");
    }
    expect(
      profiles.every((p) => JSON.stringify(p) === JSON.stringify(profiles[0])),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
