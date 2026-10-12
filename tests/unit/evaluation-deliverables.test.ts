import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../../src/evaluation/contracts";
import {
  freezeDeliverables,
  validateReport,
  verifyDeliverables,
} from "../../src/evaluation/deliverables";
import { buildPlan } from "../../src/evaluation/plan";
import { inspect } from "../../src/evaluation/records";
import { runEvaluation } from "../../src/evaluation/run";
import { config, fixtureRegistry, submission } from "../helpers/evaluation";
import { jpeg, png } from "../helpers/images";

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deliverables-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("freezing hashes regular files read-only and rejects links, depth and size overruns", async () => {
  const root = await temp();
  await mkdir(join(root, "img"));
  await writeFile(join(root, "report.md"), "# r");
  await writeFile(join(root, "img/a.png"), png(2, 2));
  const frozen = await freezeDeliverables(root);
  expect(frozen.map((d) => d.path)).toEqual(["img/a.png", "report.md"]);
  expect((await stat(join(root, "report.md"))).mode & 0o777).toBe(0o444);
  await verifyDeliverables(root, frozen);
  const linked = await temp();
  await symlink("/etc/passwd", join(linked, "leak"));
  await expect(freezeDeliverables(linked)).rejects.toThrow("symlink");
  const deep = await temp();
  await mkdir(join(deep, "a/b/c/d/e/f"), { recursive: true });
  await writeFile(join(deep, "a/b/c/d/e/f/x"), "x");
  await expect(freezeDeliverables(deep)).rejects.toThrow("deep");
  const big = await temp();
  await writeFile(join(big, "big"), Buffer.alloc(LIMITS.deliverable + 1));
  await expect(freezeDeliverables(big)).rejects.toThrow("too large");
  const many = await temp();
  for (let i = 0; i <= LIMITS.deliverable_files; i++)
    await writeFile(join(many, `f${i}`), "x");
  await expect(freezeDeliverables(many)).rejects.toThrow("Too many");
});
test("tampering or added files after freezing is detected before scoring", async () => {
  const root = await temp();
  await writeFile(join(root, "a.txt"), "a");
  const frozen = await freezeDeliverables(root);
  await writeFile(join(root, "extra.txt"), "x");
  await expect(verifyDeliverables(root, frozen)).rejects.toThrow("changed");
  await rm(join(root, "extra.txt"));
  await chmod(join(root, "a.txt"), 0o600);
  await writeFile(join(root, "a.txt"), "b");
  await expect(verifyDeliverables(root, frozen)).rejects.toThrow("integrity");
});
const output = {
  kind: "report" as const,
  instructions: "x",
  report_file: "report.md",
  image_types: ["png" as const, "jpeg" as const],
  max_images: 2,
  max_image_bytes: 4096,
  max_report_bytes: 4096,
};
test("reports must reference delivered images of allowed types by relative path", async () => {
  const root = await temp();
  await writeFile(
    join(root, "report.md"),
    "# R\n![a](a.png)\n![b](./b.jpg)\n![a again](a.png)",
  );
  await writeFile(join(root, "a.png"), png(4, 3));
  await writeFile(join(root, "b.jpg"), jpeg(5, 6));
  await writeFile(join(root, "unused.png"), png(1, 1));
  const frozen = await freezeDeliverables(root);
  expect(await validateReport(output, root, frozen)).toMatchObject({
    images: ["a.png", "b.jpg"],
  });
  for (const [body, message] of [
    ["![x](https://example.com/a.png)", "relative"],
    ["![x](/etc/a.png)", "relative"],
    ["![x](../a.png)", "Unsafe"],
    ["![x](missing.png)", "not delivered"],
    ["![x](report.md)", "type"],
  ] as const) {
    const r = await temp();
    await writeFile(join(r, "report.md"), body);
    await writeFile(join(r, "a.png"), png(1, 1));
    await expect(
      validateReport(output, r, await freezeDeliverables(r)),
    ).rejects.toThrow(message);
  }
  const none = await temp();
  await writeFile(join(none, "other.md"), "x");
  await expect(
    validateReport(output, none, await freezeDeliverables(none)),
  ).rejects.toThrow("Missing report");
  const binary = await temp();
  await writeFile(join(binary, "report.md"), Buffer.from([0xff, 0xfe, 0x00]));
  await expect(
    validateReport(output, binary, await freezeDeliverables(binary)),
  ).rejects.toThrow("UTF-8");
  const crowded = await temp();
  await writeFile(
    join(crowded, "report.md"),
    "![1](1.png) ![2](2.png) ![3](3.png)",
  );
  for (const n of [1, 2, 3])
    await writeFile(join(crowded, `${n}.png`), png(1, 1));
  await expect(
    validateReport(output, crowded, await freezeDeliverables(crowded)),
  ).rejects.toThrow("Too many");
});
test("runner freezes adapter files, quarantines invalid deliverables and fails invalid reports", async () => {
  const root = await temp();
  await writeFile(join(root, "data.csv"), "value\n1\n2\n");
  const registry = fixtureRegistry(root, async (i) => {
    if (i.unit_id === "unit-000001") {
      await writeFile(join(i.deliverables_root, "result.txt"), "3");
    } else await symlink("/etc/passwd", join(i.deliverables_root, "leak"));
    return submission(i.unit_id);
  });
  const result = await runEvaluation(
    await buildPlan(config(), registry),
    registry,
    join(root, "runs"),
    { environment: {} },
  );
  const view = await inspect(result.directory);
  expect(view.records.map((r) => r.execution_status)).toEqual([
    "completed",
    "failed",
  ]);
  expect(view.records[1]?.reason).toContain("invalid_deliverables");
  expect(
    await Bun.file(
      join(result.directory, "units/unit-000002/deliverables.rejected/leak"),
    ).exists(),
  ).toBe(true);
  // A failed delivery is still scored by the benchmark rule (zero), not as a scoring error.
  expect(view.records[1]?.scoring_status).toBe("scored");
  const file = join(
    result.directory,
    "units/unit-000001/deliverables/result.txt",
  );
  await chmod(file, 0o600);
  await writeFile(file, "4");
  await expect(inspect(result.directory)).rejects.toThrow("integrity");
});
