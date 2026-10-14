import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineExecution } from "../../src/baselines/execution";
import { DEFAULT_LIMITS } from "../../src/execution/protocol";

for (const backend of ["persistent-kernel", "fresh-script"] as const) {
  test(`baseline ${backend}: actual Docker denies host secrets, private data, other runs and network`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "baseline-isolation-")),
    );
    const original = process.env.BASELINE_SENTINEL_SECRET;
    process.env.BASELINE_SENTINEL_SECRET = "must-not-cross-boundary";
    try {
      await mkdir(join(root, "input"));
      await writeFile(join(root, "input/allowed.csv"), "x\n1\n");
      await writeFile(join(root, "private-labels.csv"), "SECRET_LABEL\n");
      await writeFile(join(root, "other-run.txt"), "OTHER_RUN\n");
      const execution = await baselineExecution({
        config: {
          run_id: "baseline-isolation",
          backend,
          image: "statigent-runtime:baselines-cpu-v1",
          input_root: join(root, "input"),
          inputs: ["allowed.csv"],
          staging_root: join(root, "staging"),
          seed: 7,
          limits: {
            ...DEFAULT_LIMITS,
            cpus: 2,
            memory_bytes: 4 * 1024 ** 3,
            startup_timeout_ms: 30000,
            task_timeout_ms: 60000,
          },
        },
        artifactDirectory: join(root, "artifacts"),
        event: async () => {},
      });
      try {
        const result = await execution.execute(
          `import os, pathlib, socket
assert "BASELINE_SENTINEL_SECRET" not in os.environ
assert not pathlib.Path(${JSON.stringify(join(root, "private-labels.csv"))}).exists()
assert not pathlib.Path(${JSON.stringify(join(root, "other-run.txt"))}).exists()
assert not pathlib.Path(${JSON.stringify(process.cwd())}).exists()
assert pathlib.Path('/input/allowed.csv').read_text() == 'x\\n1\\n'
s = socket.socket(); s.settimeout(1)
try:
    s.connect(('1.1.1.1', 443))
except OSError:
    pass
else:
    raise AssertionError('network available')
finally:
    s.close()
pathlib.Path('report.md').write_text('# Explicit output\\n')
print('isolation passed')`,
          "probe",
          new AbortController().signal,
        );
        expect(result.status).toBe("ok");
        expect(result.preview).toContain("isolation passed");
        expect(
          (await execution.artifacts.read("report.md")).toString(),
        ).toContain("Explicit output");
        await expect(
          execution.artifacts.read("../private-labels.csv"),
        ).rejects.toThrow();
        await expect(
          execution.artifacts.read("other-run.txt"),
        ).rejects.toThrow();
      } finally {
        await execution.close();
      }
      expect(execution.session.closeResult).toBeDefined();
      expect(execution.session.closeResult?.cleanup_error).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.BASELINE_SENTINEL_SECRET;
      else process.env.BASELINE_SENTINEL_SECRET = original;
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
}
