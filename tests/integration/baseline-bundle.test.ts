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
import { freezeContainerBundle, readBundle } from "../../src/baselines/bundle";
import { baselineExecution } from "../../src/baselines/execution";
import { inspectImage } from "../../src/evaluation/agents/docker";
import { command } from "../../src/evaluation/process";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";

test("freeze pauses all writers, collects complete bundle and detects changes", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "baseline-bundle-")),
  );
  await mkdir(join(root, "input"));
  const image = await inspectImage("statigent-runtime:baselines-cpu-v1");
  const execution = await baselineExecution({
    config: {
      run_id: "bundle",
      image: String(image.image_id),
      backend: "persistent-kernel",
      input_root: join(root, "input"),
      inputs: [],
      staging_root: join(root, "stage"),
      seed: 7,
      limits: { ...DEFAULT_LIMITS, task_timeout_ms: 60000 },
    },
    artifactDirectory: join(root, "artifacts"),
    event: async () => {},
  });
  try {
    const result = await execution.execute(
      "from pathlib import Path\nimport subprocess, sys\np = Path('/tmp/baseline-models/selected')\np.mkdir(parents=True)\n(p/'predict.py').write_text('print(42)')\n(p/'model.bin').write_bytes(b'model')\nsubprocess.Popen([sys.executable, '-c', \"from pathlib import Path; import time; p=Path('/tmp/baseline-models/selected/counter'); [(p.write_text(str(i)), time.sleep(.01)) for i in range(10000)]\"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n",
      "fit",
      new AbortController().signal,
    );
    expect(result.status).toBe("ok");
    const container = execution.session.containerName;
    if (!container) throw new Error("Missing container");
    const frozen = await freezeContainerBundle({
      container,
      bundle: "selected",
      entrypoint: "predict.py",
      destination: join(root, "frozen"),
      image: String(image.image_id),
      platform: String(image.platform),
      maxFiles: 1000,
      maxBytes: 1024 * 1024,
      signal: new AbortController().signal,
      timeout_ms: 30000,
      stop: () => execution.closeAfterSnapshot(),
    });
    expect(frozen.manifest.files.map((f) => f.path)).toContain("predict.py");
    expect((await readBundle(join(root, "frozen"))).manifest.bundle_id).toBe(
      frozen.manifest.bundle_id,
    );
    await expect(command(["docker", "inspect", container])).rejects.toThrow();
    const file = join(frozen.root, "model.bin");
    await chmod(file, 0o644);
    await writeFile(file, "tampered");
    await expect(readBundle(join(root, "frozen"))).rejects.toThrow();
    await writeFile(file, "model");
    await chmod(frozen.root, 0o755);
    await writeFile(join(frozen.root, "extra"), "new");
    await expect(readBundle(join(root, "frozen"))).rejects.toThrow();
    await rm(join(frozen.root, "extra"));
    await rm(file);
    await expect(readBundle(join(root, "frozen"))).rejects.toThrow();
    expect(await readFile(join(root, "frozen/bundle.json"), "utf8")).toContain(
      frozen.manifest.bundle_id,
    );
  } finally {
    await execution.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
