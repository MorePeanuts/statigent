import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aggregate } from "../../src/evaluation/aggregate";
import {
  createInfiAgent,
  type Resource,
} from "../../src/evaluation/benchmarks/infiagent";
import { describeFile } from "../../src/evaluation/files";
import { command } from "../../src/evaluation/process";
import type { UnitRecord } from "../../src/evaluation/records";
import { submission } from "../helpers/evaluation";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "infi-test-")));
  roots.push(root);
  const files: Record<string, string> = {
    "public/questions.jsonl": `${JSON.stringify({
      id: 1,
      question: "Sum?",
      constraints: "Use data",
      format: "@a[value] @b[value]",
      file_name: "data.csv",
    })}\n`,
    "public/tables/data.csv": "value\n1\n2\n",
    "private/labels.jsonl": `${JSON.stringify({
      id: 1,
      common_answers: [
        ["a", "1"],
        ["b", "2"],
      ],
    })}\n`,
    "upstream/examples/DA-Agent/eval_closed_form.py": "fixture",
    "upstream/LICENSE": "fixture",
  };
  const resources: Resource[] = [];
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), data);
    resources.push({ ...(await describeFile(root, path)), url: "synthetic" });
  }
  return { root, adapter: createInfiAgent(resources) };
}
test("benchmark public catalog excludes labels and detects modified inputs", async () => {
  const { root, adapter } = await setup();
  const catalog = await adapter.catalog({ root });
  expect(catalog.tasks).toHaveLength(1);
  expect(JSON.stringify(catalog.tasks)).not.toContain("common_answers");
  await adapter.preflight({ root }, catalog.tasks);
  await writeFile(join(root, "public/tables/data.csv"), "changed");
  await expect(adapter.catalog({ root })).rejects.toThrow("integrity");
});
test("real scoring bridge and fixed denominator differ explicitly from upstream coverage", async () => {
  const { root, adapter } = await setup();
  const task = (await adapter.catalog({ root })).tasks[0];
  if (!task) throw new Error("Missing task");
  const good = await adapter.score(
    { root },
    task,
    { ...submission(), answer_text: "@a[1] @b[2]" },
    { deliverables_root: root, scoring: {}, judge: null },
  );
  const bad = await adapter.score(
    { root },
    task,
    { ...submission("unit-000002"), status: "failed", answer_text: "" },
    { deliverables_root: root, scoring: {}, judge: null },
  );
  const records = [good, bad].map(
    (score, i): UnitRecord => ({
      unit: {
        id: score.unit_id,
        task_id: task.id,
        agent_id: "a",
        repetition: 0,
        seed: 1,
      },
      execution_status: i === 0 ? "completed" : "failed",
      scoring_status: "scored",
      score,
      reason: "",
      started_at: "now",
      ended_at: "now",
      elapsed_ms: 1,
      effective_budget: null,
      budget_status: "within",
      submission_sha256: null,
    }),
  );
  expect(aggregate(records).metrics).toEqual({ abq: 0.5, psaq: 0.5 });
  expect(await adapter.compatibility?.([good, bad])).toMatchObject({
    answered: 1,
    abq: 1,
    psaq: 1,
  });
  const second = records[1];
  if (!second) throw new Error("Missing record");
  expect(
    aggregate([
      records[0] as UnitRecord,
      {
        ...second,
        execution_status: "not_run",
        scoring_status: "pending",
        score: null,
      },
    ]).metrics,
  ).toEqual({ abq: null, psaq: null });
  await writeFile(join(root, "private/labels.jsonl"), "corrupted");
  await expect(
    adapter.score({ root }, task, submission(), {
      deliverables_root: root,
      scoring: {},
      judge: null,
    }),
  ).rejects.toThrow("integrity");
});
test("bounded process rejects invalid protocol execution, timeout and cancellation", async () => {
  await expect(command(["bun", "-e", "process.exit(2)"])).rejects.toThrow(
    "failed",
  );
  await expect(
    command(["bun", "-e", "setInterval(()=>{},1000)"], { timeout_ms: 20 }),
  ).rejects.toThrow("timed out");
  await expect(
    command(["bun", "-e", 'console.log("x".repeat(10000))'], {
      stdout_limit: 20,
    }),
  ).rejects.toThrow("limit");
  const controller = new AbortController();
  controller.abort();
  await expect(
    command(["bun", "--version"], { signal: controller.signal }),
  ).rejects.toThrow();
});
