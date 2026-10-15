import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import * as z from "zod";
import { uniqueOptionValue } from "../cli-options";
import { exportComparison } from "../evaluation/comparison";
import { buildPlan, type Registry } from "../evaluation/plan";
import { inspect } from "../evaluation/records";
import { defaultRegistry } from "../evaluation/registry";
import { createReport } from "../evaluation/report";
import { runEvaluation } from "../evaluation/run";
import { sha256 } from "../records/store";
import { methodIdSchema } from "./catalog";

export const SMOKE_HELP =
  "bun run test:smoke:baselines --preflight --scope FILE | --run --scope FILE --out NEW_DIRECTORY [--allow-model-calls] [--allow-training]";
const unique = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .min(1)
    .refine((x) => new Set(x).size === x.length, "Duplicate scope entries");
export const smokeScopeSchema = z.strictObject({
  schema_version: z.literal(1),
  name: z.string().regex(/^[a-z0-9-]+$/),
  configs: unique(z.string().min(1)),
  models: z.string().min(1),
  methods: unique(methodIdSchema),
  tasks: unique(z.string().min(1)),
});
export function parseBaselineSmoke(args: string[]) {
  if (!args.length || args.join(" ") === "--help") return null;
  const cli = new Command().exitOverride().helpOption(false);
  for (const name of ["scope", "out"])
    cli.addOption(new Option(`--${name} <value>`).argParser(uniqueOptionValue));
  for (const name of [
    "preflight",
    "run",
    "allow-model-calls",
    "allow-training",
  ]) {
    if (args.filter((a) => a === `--${name}`).length > 1)
      throw new Error("Duplicate flag");
    cli.option(`--${name}`);
  }
  cli.parse(args, { from: "user" });
  const options = z
    .strictObject({
      scope: z.string().min(1),
      out: z.string().min(1).optional(),
      preflight: z.boolean().default(false),
      run: z.boolean().default(false),
      allowModelCalls: z.boolean().default(false),
      allowTraining: z.boolean().default(false),
    })
    .parse(cli.opts());
  if (
    options.preflight === options.run ||
    (options.run
      ? !options.out
      : options.out || options.allowModelCalls || options.allowTraining)
  )
    throw new Error(SMOKE_HELP);
  return options;
}
export async function baselineSmoke(
  args: string[],
  registry: Registry = defaultRegistry(),
) {
  const options = parseBaselineSmoke(args);
  if (!options) return { help: SMOKE_HELP, model_calls: 0 };
  const bytes = await Bun.file(options.scope).bytes();
  if (bytes.length > 1024 ** 2) throw new Error("Scope limit");
  const scope = smokeScopeSchema.parse(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  if (
    options.run &&
    ((scope.methods.some((m) => m !== "autogluon") &&
      !options.allowModelCalls) ||
      (scope.methods.includes("autogluon") && !options.allowTraining))
  )
    throw new Error(
      "Explicit --allow-model-calls/--allow-training required for selected methods",
    );
  const profiles = await Bun.file(scope.models).json(),
    plans = [],
    seen = new Set<string>();
  for (const path of scope.configs) {
    const raw = await Bun.file(path).json();
    if (!Array.isArray(raw.agents) || !Array.isArray(raw.benchmark?.task_ids))
      throw new Error("Invalid scope configuration");
    raw.agents = raw.agents.filter((a: { adapter: string }) =>
      scope.methods.includes(a.adapter as z.infer<typeof methodIdSchema>),
    );
    raw.benchmark.task_ids = raw.benchmark.task_ids.filter((id: string) =>
      scope.tasks.includes(`${raw.benchmark.adapter}/${id}`),
    );
    if (!raw.agents.length || !raw.benchmark.task_ids.length)
      throw new Error("Empty scope selection");
    const plan = await buildPlan(raw, registry, profiles);
    if (plan.config.purpose !== "development" || plan.config.repetitions !== 1)
      throw new Error("Development one-repeat scope required");
    for (const budget of [plan.config.task_budget, plan.config.batch_budget])
      if (Object.values(budget).some((v) => v === null))
        throw new Error("Finite explicit budgets required");
    for (const agent of plan.config.agents)
      for (const task of plan.tasks) {
        const key = `${plan.config.benchmark.adapter}/${task.id}:${agent.adapter}`;
        if (seen.has(key)) throw new Error("Duplicate smoke unit");
        seen.add(key);
      }
    plans.push(plan);
  }
  const expected = scope.tasks.flatMap((t) =>
    scope.methods.map((m) => `${t}:${m}`),
  );
  if (expected.length !== seen.size || expected.some((key) => !seen.has(key)))
    throw new Error("Missing method/task in smoke scope");
  const preview = {
    scope: scope.name,
    scope_sha256: sha256(Buffer.from(bytes)),
    units: [...seen],
    plans: plans.map((p) => ({
      benchmark: p.config.benchmark.adapter,
      task_budget: p.config.task_budget,
      batch_budget: p.config.batch_budget,
    })),
    status: "preflight",
    model_calls: 0,
  };
  if (!options.run) return preview;
  const root = resolve(options.out ?? "");
  await mkdir(root, { recursive: false });
  await writeFile(
    join(root, "scope.json"),
    JSON.stringify({ ...preview, scope }),
    { flag: "wx" },
  );
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const runs = [];
  let status = "completed";
  let failure: string | null = null;
  try {
    for (const plan of plans) {
      const run = await runEvaluation(
        plan,
        registry,
        join(root, "evaluations"),
        { signal: controller.signal },
      );
      const report = await createReport(
        run.directory,
        registry,
        undefined,
        run.score_id,
      );
      const comparison = await exportComparison(run.directory, report.score_id);
      runs.push({ run, report_directory: report.directory, comparison });
      const view = await inspect(run.directory);
      if (
        run.status !== "completed" ||
        view.records.some((r) => r.execution_status !== "completed")
      ) {
        status = "incomplete";
        break;
      }
    }
  } catch (error) {
    status = "incomplete";
    failure = String(error);
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await writeFile(
      join(root, "result.json"),
      JSON.stringify({ status, runs, failure }),
      { flag: "wx" },
    );
  }
  return { status, runs, directory: root };
}
if (import.meta.main) {
  try {
    const result = await baselineSmoke(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if ("status" in result && result.status === "incomplete")
      process.exitCode = 1;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
