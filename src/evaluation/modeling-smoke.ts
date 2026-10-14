import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reproduce } from "../modeling/delivery";
import { inspectModeling } from "../modeling/records";
import { workflowTrajectory } from "../modeling/trajectory";
import { integer, keys, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";
import { exportComparison } from "./comparison";
import { id } from "./contracts";
import { regular } from "./files";
import { buildPlan, type Registry } from "./plan";
import { codeSnapshot, inspect, readSubmission } from "./records";
import { defaultRegistry } from "./registry";
import { createReport } from "./report";
import { runEvaluation } from "./run";

export const MODELING_SMOKE_HELP =
  "bun run test:smoke:modeling-benchmarks --preflight --scope FILE | --run --allow-model-calls --scope FILE --out NEW_DIRECTORY";
export function parseModelingSmoke(args: string[]) {
  if (!args.length || args.join(" ") === "--help") return null;
  let mode: "preflight" | "run" | null = null,
    allowed = false;
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--preflight" || arg === "--run") {
      if (mode) throw new Error("Choose one explicit smoke mode");
      mode = arg === "--run" ? "run" : "preflight";
    } else if (arg === "--allow-model-calls") {
      if (allowed) throw new Error("Duplicate model authorization flag");
      allowed = true;
    } else if (arg === "--scope" || arg === "--out") {
      const value = args[++index];
      if (!value || value.startsWith("--") || values[arg])
        throw new Error(MODELING_SMOKE_HELP);
      values[arg] = value;
    } else throw new Error(MODELING_SMOKE_HELP);
  }
  if (
    !mode ||
    !values["--scope"] ||
    (mode === "run" ? !allowed || !values["--out"] : allowed || values["--out"])
  )
    throw new Error(
      "Live runs require explicit --run --allow-model-calls and a new output directory; preflight is read-only",
    );
  return {
    mode,
    scope: resolve(values["--scope"]),
    out: values["--out"] ? resolve(values["--out"]) : null,
  };
}

export async function modelingSmoke(
  args: string[],
  registry: Registry = defaultRegistry(),
) {
  const options = parseModelingSmoke(args);
  if (!options) return { help: MODELING_SMOKE_HELP, model_calls: 0 };
  const scopeBytes = await Bun.file(options.scope).bytes();
  if (scopeBytes.length > 1024 ** 2) throw new Error("Smoke scope limit");
  const scope = obj(JSON.parse(Buffer.from(scopeBytes).toString("utf8")));
  keys(scope, [
    "schema_version",
    "name",
    "config_files",
    "models_file",
    "allowed_tasks",
    "allowed_methods",
    "model_profile",
    "seed",
    "resource_version",
  ]);
  if (scope.schema_version !== 1)
    throw new Error("Invalid smoke scope version");
  const name = id(scope.name),
    files = strings(scope.config_files, "explicit configs"),
    methods = strings(scope.allowed_methods, "explicit methods"),
    tasks = strings(scope.allowed_tasks, "explicit benchmark/task pairs"),
    profile = str(scope.model_profile, "model profile"),
    resource = str(scope.resource_version, "resource version"),
    seed = integer(scope.seed, "seed", 0);
  if (
    !files.length ||
    files.length > 8 ||
    !tasks.length ||
    !methods.length ||
    [files, methods, tasks].some((list) => new Set(list).size !== list.length)
  )
    throw new Error("Invalid smoke scope selection");
  const profiles = await Bun.file(str(scope.models_file, "models file")).json();
  const plans = [],
    actual = new Set<string>();
  const budgets = { model_attempts: 0, total_tokens: 0, timeout_ms: 0 };
  for (const file of files) {
    const plan = await buildPlan(
      await Bun.file(file).json(),
      registry,
      profiles,
    );
    if (
      plan.config.purpose !== "development" ||
      plan.config.seed !== seed ||
      plan.config.repetitions !== 1 ||
      plan.tasks.some((t) => t.output.kind !== "predictions")
    )
      throw new Error("Smoke scope/task mismatch");
    for (const agent of plan.config.agents) {
      if (
        agent.adapter !== "statigent-modeling" ||
        agent.model?.id !== profile ||
        !methods.includes(String(agent.options.method)) ||
        agent.options.resource_version !== resource ||
        !agent.require_seed
      )
        throw new Error("Smoke method/model/resource mismatch");
      for (const task of plan.tasks) {
        const pair = `${plan.config.benchmark.adapter}/${task.id}`;
        const key = `${pair}:${agent.options.method}`;
        if (!tasks.includes(pair) || actual.has(key))
          throw new Error("Duplicate or out-of-scope smoke unit");
        actual.add(key);
      }
    }
    for (const key of [
      "model_attempts",
      "total_tokens",
      "timeout_ms",
    ] as const) {
      const budget = plan.config.batch_budget[key];
      if (budget === null)
        throw new Error(
          "Live smoke requires explicit finite model and time budgets",
        );
      budgets[key] += budget;
    }
    plans.push(plan);
  }
  if (actual.size !== tasks.length * methods.length)
    throw new Error("Incomplete declared smoke matrix");
  const preflight = {
    schema_version: 1,
    name,
    scope_sha256: sha256(Buffer.from(scopeBytes)),
    status: "passed",
    scope,
    code: await codeSnapshot(),
    units: actual.size,
    budgets,
    model_calls: 0,
    fits: 0,
    automatic_rerun: false,
    plans: plans.map((plan, index) => ({
      config: files[index],
      plan_sha256: plan.sha256,
      units: plan.units,
    })),
  };
  if (options.mode === "preflight") return preflight;
  if (!options.out) throw new Error("Missing run root");
  const root = options.out;
  await mkdir(root, { recursive: false });
  await writeFile(
    join(root, "preflight.json"),
    JSON.stringify(preflight, null, 2),
    { flag: "wx", mode: 0o400 },
  );
  await writeFile(join(root, "plans.json"), JSON.stringify(plans, null, 2), {
    flag: "wx",
    mode: 0o400,
  });
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const results: Record<string, unknown>[] = [];
  let haltReason: string | null = null;
  try {
    for (const plan of plans) {
      if (controller.signal.aborted || haltReason) {
        results.push({
          benchmark: plan.config.benchmark.adapter,
          status: "not_run",
          reason: haltReason ?? "cancelled",
        });
        continue;
      }
      try {
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
        const comparison = await exportComparison(
          run.directory,
          report.score_id,
        );
        const view = await inspect(run.directory),
          reproductions = [],
          observations = [];
        for (const record of view.records) {
          const stored = await readSubmission(run.directory, record);
          if (
            record.budget_status === "unknown" ||
            stored?.submission.cleanup_error ||
            stored?.submission.record_error
          )
            haltReason = "unsettled_prior_batch";
          if (stored?.submission.native_run) {
            const native = await inspectModeling(
                stored.submission.native_run.directory,
              ),
              payloads = [];
            for (const event of native.events.filter(
              (e) => e.type === "action_accepted",
            ))
              payloads.push(
                obj(
                  JSON.parse(
                    await readFile(
                      await regular(
                        stored.submission.native_run.directory,
                        str(obj(event.content_ref).path, "action payload"),
                      ),
                      "utf8",
                    ),
                  ),
                ),
              );
            observations.push({
              unit_id: record.unit.id,
              trajectory: workflowTrajectory(
                native.manifest,
                native.events,
                payloads,
              ),
              usage: native.manifest.usage,
            });
          }
          if (
            controller.signal.aborted ||
            record.execution_status !== "completed" ||
            !stored?.submission.native_run
          ) {
            reproductions.push({
              unit_id: record.unit.id,
              status: "not_run",
              reason: controller.signal.aborted
                ? "cancelled"
                : "no_complete_delivery",
            });
            continue;
          }
          try {
            const reproduction = await reproduce(
              stored.submission.native_run.directory,
              join(root, "reproductions"),
              "predict",
            );
            reproductions.push({
              unit_id: record.unit.id,
              result: reproduction,
            });
          } catch (error) {
            reproductions.push({
              unit_id: record.unit.id,
              status: "failed",
              reason: String(error),
            });
          }
        }
        const acceptance =
          view.records.every(
            (record) =>
              record.execution_status === "completed" &&
              record.scoring_status === "scored",
          ) &&
          reproductions.every(
            (r) => "result" in r && r.result?.status === "passed",
          ) &&
          observations.length === view.records.length &&
          observations.every(
            (o) =>
              o.trajectory.accounting === "known" &&
              (view.plan.config.agents.find(
                (a) =>
                  a.id ===
                  view.records.find((r) => r.unit.id === o.unit_id)?.unit
                    .agent_id,
              )?.options.method !== "no_eda" ||
                o.trajectory.analysis_calls === 0) &&
              (view.plan.config.agents.find(
                (a) =>
                  a.id ===
                  view.records.find((r) => r.unit.id === o.unit_id)?.unit
                    .agent_id,
              )?.options.method !== "collaborative" ||
                o.trajectory.collaboration === "covered"),
          );
        results.push({
          benchmark: plan.config.benchmark.adapter,
          ...run,
          acceptance: acceptance && !haltReason ? "passed" : "incomplete",
          report: report.directory,
          comparison,
          reproductions,
          observations,
          units: view.records.map((record) => ({
            unit: record.unit,
            execution_status: record.execution_status,
            scoring_status: record.scoring_status,
            reason: record.reason,
          })),
        });
      } catch (error) {
        haltReason = "prior_batch_failure";
        results.push({
          benchmark: plan.config.benchmark.adapter,
          status: "failed",
          error: String(error),
          automatic_rerun: false,
        });
      }
      await writeFile(
        join(root, "result.json"),
        JSON.stringify(
          {
            name,
            scope_sha256: preflight.scope_sha256,
            results,
            automatic_rerun: false,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        name,
        scope_sha256: preflight.scope_sha256,
        status: results.every((r) => r.acceptance === "passed")
          ? "passed"
          : "incomplete",
        results,
        automatic_rerun: false,
      },
      null,
      2,
    ),
  );
  return {
    directory: root,
    status: results.every((r) => r.acceptance === "passed")
      ? "passed"
      : "incomplete",
    results,
  };
}
if (import.meta.main) {
  try {
    const result = await modelingSmoke(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if ("status" in result && result.status === "incomplete")
      process.exitCode = 1;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
