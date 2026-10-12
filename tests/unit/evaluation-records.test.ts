import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupEvaluation } from "../../src/evaluation/cleanup";
import {
  describeFile,
  publishInputs,
  verifyFiles,
} from "../../src/evaluation/files";
import { buildPlan } from "../../src/evaluation/plan";
import { EvaluationStore, inspect } from "../../src/evaluation/records";
import {
  config,
  fixtureRegistry,
  submission,
  task,
} from "../helpers/evaluation";

const roots: string[] = [];
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evaluation-")));
  roots.push(root);
  await writeFile(join(root, "data.csv"), "value\n1\n2\n");
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("publication exposes only allowlisted immutable inputs and detects tampering", async () => {
  const root = await setup();
  await writeFile(join(root, "private.json"), "private");
  const target = join(root, "published");
  await publishInputs(root, task, target);
  expect(await Bun.file(join(target, "private.json")).exists()).toBe(false);
  await verifyFiles(target, task.inputs);
  await writeFile(join(root, "data.csv"), "changed");
  await expect(publishInputs(root, task, join(root, "bad"))).rejects.toThrow(
    "integrity",
  );
});
test("input publication rejects symlinks and escaping paths", async () => {
  const root = await setup();
  await symlink(join(root, "data.csv"), join(root, "link.csv"));
  for (const path of ["link.csv", "../data.csv", "/etc/passwd"])
    await expect(describeFile(root, path)).rejects.toThrow();
});
test("records exist before invocation, freeze once, and inspect interrupted runs read-only", async () => {
  const root = await setup(),
    plan = await buildPlan(config(), fixtureRegistry(root));
  const store = await EvaluationStore.create(
    join(root, "runs"),
    plan,
    {},
    { test: true },
  );
  let view = await inspect(store.directory);
  expect(view.records).toHaveLength(2);
  const record = view.records[0];
  if (!record) throw new Error("Missing record");
  record.execution_status = "running";
  await store.unit(record);
  const before = await readFile(
    join(store.directory, "units", record.unit.id, "record.json"),
    "utf8",
  );
  view = await inspect(store.directory);
  expect(view.records[0]?.execution_status).toBe("unconfirmed");
  expect(
    await readFile(
      join(store.directory, "units", record.unit.id, "record.json"),
      "utf8",
    ),
  ).toBe(before);
  record.submission_sha256 = await store.freeze(submission(record.unit.id));
  record.execution_status = "completed";
  await store.unit(record);
  await expect(store.freeze(submission(record.unit.id))).rejects.toThrow();
  await chmod(
    join(store.directory, "units", record.unit.id, "submission.json"),
    0o600,
  );
  await writeFile(
    join(store.directory, "units", record.unit.id, "submission.json"),
    "{}",
  );
  await expect(inspect(store.directory)).rejects.toThrow("integrity");
});
test("record quotas and storage errors do not silently succeed", async () => {
  const root = await setup(),
    plan = await buildPlan(config(), fixtureRegistry(root));
  const store = await EvaluationStore.create(join(root, "runs"), plan, {}, {});
  await expect(store.event("large", "x".repeat(262145))).rejects.toThrow(
    "limit",
  );
  await expect(store.json("missing/file.json", {})).rejects.toThrow();
  await store.json("redaction.json", {
    api_key: "value",
    api_key_env: "TEST_KEY",
  });
  expect(
    await Bun.file(join(store.directory, "redaction.json")).json(),
  ).toEqual({ api_key: "[REDACTED]", api_key_env: "TEST_KEY" });
});

test("disk records are runtime validated before reporting costs", async () => {
  const root = await setup(),
    plan = await buildPlan(config(), fixtureRegistry(root));
  const store = await EvaluationStore.create(join(root, "runs"), plan, {}, {});
  const path = join(store.directory, "units/unit-000001/record.json");
  const value = await Bun.file(path).json();
  value.elapsed_ms = "free";
  await writeFile(path, JSON.stringify(value));
  await expect(inspect(store.directory)).rejects.toThrow("timing");
  const cleaned: string[] = [];
  await mkdir(join(store.directory, "native/unit-000001/.staging"), {
    recursive: true,
  });
  await cleanupEvaluation(store.directory, {
    external: async (identity) => {
      cleaned.push(identity);
    },
    native: async () => [],
  });
  expect(cleaned).toEqual([store.manifest.evaluation_id]);
});
