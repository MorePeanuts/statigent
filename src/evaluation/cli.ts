import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import { uniqueOptionValue } from "../cli-options";
import { auditModeling } from "./benchmarks/modeling/audit";
import { auditPreparations } from "./benchmarks/modeling/preparation-audit";
import { PREPARE_HELP, prepareModeling } from "./benchmarks/modeling/prepare";
import { cleanupEvaluation } from "./cleanup";
import { exportComparison } from "./comparison";
import { id } from "./contracts";
import { buildPlan, type Registry } from "./plan";
import { inspect } from "./records";
import { defaultRegistry } from "./registry";
import {
  createReport,
  parseJudgeBudget,
  type RescoreOptions,
  rescore,
} from "./report";
import { runEvaluation } from "./run";

export const HELP = `bun run evaluate plan|run --config FILE [--models FILE] [--root RUN_ROOT]\nbun run evaluate inspect|cleanup EVALUATION_ID [--root RUN_ROOT]\nbun run evaluate score EVALUATION_ID [--root RUN_ROOT] [--allow-model-calls --judge-budget FILE]\nbun run evaluate compare EVALUATION_ID --score-id SCORE_ID [--root RUN_ROOT]\nbun run evaluate audit [--data-root benchmarks] [--catalog FILE] [--output NEW_FILE]\nbun run evaluate audit-prepare --config FILE --out NEW_DIRECTORY\n${PREPARE_HELP}`;
export function parseArguments(args: string[]) {
  if (!args.length || args[0] === "--help") return null;
  const [operation, ...rest] = args;
  if (
    !operation ||
    !["plan", "run", "inspect", "score", "cleanup", "compare"].includes(
      operation,
    )
  )
    throw new Error(HELP);
  const cli = new Command()
    .helpOption(false)
    .configureOutput({ writeErr: () => {} })
    .exitOverride()
    .argument("[evaluationId]");
  for (const flag of ["--config", "--models", "--root"])
    cli.addOption(new Option(`${flag} <value>`).argParser(uniqueOptionValue));
  if (operation === "score") {
    cli.addOption(
      new Option("--judge-budget <value>").argParser(uniqueOptionValue),
    );
    cli.addOption(new Option("--allow-model-calls"));
  }
  if (operation === "compare")
    cli.addOption(
      new Option("--score-id <value>").argParser(uniqueOptionValue),
    );
  try {
    cli.parse(rest, { from: "user" });
    if (rest.filter((arg) => arg === "--allow-model-calls").length > 1)
      throw new Error(HELP);
  } catch {
    throw new Error(HELP);
  }
  const values = cli.opts<{
    config?: string;
    models?: string;
    root?: string;
    judgeBudget?: string;
    scoreId?: string;
    allowModelCalls?: boolean;
  }>();
  const evaluationId = cli.args[0] === undefined ? undefined : id(cli.args[0]);
  const planning = operation === "plan" || operation === "run";
  if (operation === "compare" && !values.scoreId)
    throw new Error("compare requires --score-id from an existing report");
  if (
    planning
      ? !values.config || evaluationId !== undefined
      : !evaluationId || values.config || values.models
  )
    throw new Error(HELP);
  return {
    operation,
    evaluationId,
    allowModelCalls: values.allowModelCalls === true,
    judgeBudget: values.judgeBudget,
    scoreId: values.scoreId,
    config: values.config,
    models: values.models ?? "configs/models.json",
    root: resolve(values.root ?? "runs/evaluations"),
  };
}
export async function main(
  args: string[],
  registry: Registry = defaultRegistry(),
  dependencies: Pick<RescoreOptions, "judgeFactory"> = {},
): Promise<unknown> {
  if (args[0] === "audit") return auditModeling(args.slice(1));
  if (args[0] === "prepare" || args[0] === "audit-prepare") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      if (args[0] === "audit-prepare")
        return await auditPreparations(args.slice(1), {
          signal: controller.signal,
          progress: (value) => console.error(JSON.stringify(value)),
        });
      return await prepareModeling(args.slice(1), {
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
  const options = parseArguments(args);
  if (!options) return { help: HELP };
  if (options.operation === "plan" || options.operation === "run") {
    const config = await Bun.file(options.config ?? "").json(),
      profiles = await Bun.file(options.models).json();
    const plan = await buildPlan(config, registry, profiles);
    if (options.operation === "plan") return plan;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      const run = await runEvaluation(plan, registry, options.root, {
        signal: controller.signal,
        judgeFactory: dependencies.judgeFactory,
      });
      const report = await createReport(
        run.directory,
        registry,
        undefined,
        run.score_id,
      );
      return {
        ...run,
        score_id: report.score_id,
        report_directory: report.directory,
        groups: report.report.groups,
      };
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
  const directory = join(options.root, id(options.evaluationId));
  if (options.operation === "inspect") return inspect(directory);
  if (options.operation === "compare")
    return exportComparison(directory, id(options.scoreId));
  if (options.operation === "score")
    return rescore(directory, registry, {
      ...dependencies,
      allowModelCalls: options.allowModelCalls,
      judgeBudget: options.judgeBudget
        ? parseJudgeBudget(await Bun.file(options.judgeBudget).json())
        : undefined,
    });
  return cleanupEvaluation(directory);
}
if (import.meta.main) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (
      result &&
      typeof result === "object" &&
      "status" in result &&
      result.status === "incomplete"
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
