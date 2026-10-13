import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binary from "../../configs/modeling/binary-prepare.json";
import source from "../../configs/modeling/synthetic-prepare.json";
import { loadDataset, prepareDataset } from "../../src/modeling/data";
import { createBasicProfile } from "../../src/modeling/profile";

async function fixture(classification = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "model-profile-"));
  await prepareDataset(classification ? binary : source, join(root, "data"));
  const data = await loadDataset(join(root, "data"));
  return { root, ...data };
}
for (const classification of [false, true])
  test(`trusted profile uses only internal training members (${classification})`, async () => {
    const f = await fixture(classification);
    const result = await createBasicProfile({ ...f, timeout_ms: 30000 });
    expect(result.profile.rows).toBe(f.dataset.split.train.length);
    expect(
      result.profile.columns.find((c) => c.name === f.dataset.target)?.type,
    ).toBe(classification ? "categorical" : "numeric");
    const request = JSON.parse(
      await readFile(join(f.root, "basic-profile/request.json"), "utf8"),
    );
    expect(JSON.stringify(request)).not.toContain("test.csv");
    const input = await readFile(request.input.path, "utf8");
    expect(input.split("\n").filter(Boolean)).toHaveLength(
      f.dataset.split.train.length + 1,
    );
    expect(result.elapsed_ms).toBeGreaterThan(0);
  }, 30000);

test("profile rejects wrong response identity and preserves failure without accepting statistics", async () => {
  const f = await fixture();
  await expect(
    createBasicProfile({
      ...f,
      timeout_ms: 30000,
      execute: async () => ({
        stdout: JSON.stringify({
          version: 1,
          request_id: "other",
          ok: true,
          profile: {},
        }),
        stderr: "",
      }),
    }),
  ).rejects.toThrow("identity mismatch");
  expect(
    await readFile(join(f.root, "basic-profile/failure.json"), "utf8"),
  ).toContain("identity mismatch");
});

test("profile child rejects changed snapshot bytes and cancelled preparation", async () => {
  const f = await fixture();
  const { command } = await import("../../src/evaluation/process");
  await expect(
    createBasicProfile({
      ...f,
      timeout_ms: 30000,
      execute: async (args, options) => {
        const request = JSON.parse(options?.input ?? "{}");
        await chmod(request.input.path, 0o600);
        await writeFile(request.input.path, "id,x,target\n1,0,0\n");
        return command(args, options);
      },
    }),
  ).rejects.toThrow("identity mismatch");
  const other = await fixture();
  await expect(
    createBasicProfile({
      ...other,
      timeout_ms: 30000,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow("profile_failure");
}, 30000);
