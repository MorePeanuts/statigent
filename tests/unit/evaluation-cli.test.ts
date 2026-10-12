import { expect, test } from "bun:test";
import selection from "../../configs/evaluations/infiagent-development-selection.json";
import smoke from "../../configs/evaluations/infiagent-smoke.json";
import example from "../../configs/evaluations/synthetic-command.json";
import profiles from "../../configs/models.json";
import { main, parseArguments } from "../../src/evaluation/cli";
import { selectDevelopment } from "../../src/evaluation/development";
import { buildPlan, validateConfig } from "../../src/evaluation/plan";
import { defaultRegistry } from "../../src/evaluation/registry";

test("CLI requires explicit run, rejects ambiguous arguments and only shows help by default", async () => {
  expect(await main([])).toHaveProperty("help");
  for (const args of [
    ["run"],
    ["plan", "x"],
    ["inspect", "../bad"],
    ["run", "--config", "x", "--network", "true"],
  ])
    expect(() => parseArguments(args)).toThrow();
  expect(parseArguments(["run", "--config", "x"])?.operation).toBe("run");
});
test("documented offline plan does not start Docker or models", async () => {
  const plan = await buildPlan(example, defaultRegistry(), profiles);
  expect(plan.units).toHaveLength(1);
  expect(plan.config.agents[0]?.model).toBeNull();
  const config = validateConfig(smoke, defaultRegistry(), profiles);
  expect(config.agents[0]?.model?.model).toBe("deepseek-flash");
  expect(config.batch_budget.model_attempts).toBe(36);
  expect(smoke.benchmark.task_ids).toEqual(["0", "5", "308"]);
});
test("development manifest obeys fixed public selection rules", () => {
  expect(selection.tasks).toHaveLength(12);
  for (const level of ["easy", "medium", "hard"])
    expect(selection.tasks.filter((t) => t.level === level)).toHaveLength(4);
  const files = selection.tasks.map((t) => t.file);
  for (const file of new Set(files))
    expect(files.filter((f) => f === file).length).toBeLessThanOrEqual(2);
  const rows = selection.tasks.map((t) => ({
    id: t.id,
    level: t.level,
    file_name: t.file,
    concepts: t.concepts,
    question: "Compute a mean",
    constraints: "Use pandas",
    format: "@a[value]",
  }));
  expect(selectDevelopment(rows).map((t) => t.id)).toEqual(
    selection.tasks.map((t) => t.id),
  );
  expect(selectDevelopment([...rows].reverse())).toEqual(
    selectDevelopment(rows),
  );
  expect(() => selectDevelopment([])).toThrow("Insufficient");
});
test("score refuses judged rescoring without explicit permission and budget", async () => {
  const { mkdtemp, realpath, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FakeJudge, judgedConfig, judgedRegistry } = await import(
    "../helpers/judge"
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "cli-judge-")));
  try {
    await writeFile(join(root, "data.csv"), "value\n1\n2\n");
    const registry = judgedRegistry(root);
    let calls = 0;
    const judgeFactory = (p: ConstructorParameters<typeof FakeJudge>[0]) =>
      new FakeJudge(p, () => {
        calls++;
        return "score:1";
      });
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify(judgedConfig()));
    const run = (await main(
      ["run", "--config", config, "--root", join(root, "runs")],
      registry,
      { judgeFactory },
    )) as { evaluation_id: string; score_id: string };
    const executed = calls;
    expect(executed).toBe(3);
    for (const args of [
      ["score", run.evaluation_id],
      ["score", run.evaluation_id, "--allow-model-calls"],
    ])
      await expect(
        main([...args, "--root", join(root, "runs")], registry, {
          judgeFactory,
        }),
      ).rejects.toThrow("--allow-model-calls");
    expect(calls).toBe(executed);
    expect(() =>
      parseArguments(["run", "--config", "x", "--allow-model-calls"]),
    ).toThrow();
    const budget = join(root, "budget.json");
    const limit = { timeout_ms: 10000, model_attempts: 5, total_tokens: 1000 };
    await writeFile(
      budget,
      JSON.stringify({ unit_budget: limit, batch_budget: limit }),
    );
    const rescored = (await main(
      [
        "score",
        run.evaluation_id,
        "--root",
        join(root, "runs"),
        "--allow-model-calls",
        "--judge-budget",
        budget,
      ],
      registry,
      { judgeFactory },
    )) as { score_id: string };
    expect(rescored.score_id).not.toBe(run.score_id);
    expect(calls).toBe(executed + 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
