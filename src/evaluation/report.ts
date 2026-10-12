import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelClient } from "../models/client";
import type { ModelProfile } from "../models/config";
import { keys, obj } from "../models/validation";
import { writeJson } from "../records/store";
import { aggregate } from "./aggregate";
import { bounded, id, LIMITS, validateTask } from "./contracts";
import {
  checkJudges,
  type JudgeBudget,
  type Registry,
  validateJudgeBudget,
} from "./plan";
import {
  codeSnapshot,
  inspect,
  readSubmission,
  type UnitRecord,
} from "./records";
import { judgeSession, scoreUnit } from "./run";

export function csv(rows: Record<string, unknown>[]): string {
  const names = [...new Set(rows.flatMap(Object.keys))];
  const cell = (value: unknown) => {
    let text =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text))
      text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return `${[
    names.map(cell).join(","),
    ...rows.map((r) => names.map((n) => cell(r[n])).join(",")),
  ].join("\n")}\n`;
}
export async function createReport(
  directory: string,
  registry: Registry,
  rescored?: UnitRecord[],
  scoreId: string = randomUUID(),
) {
  const view = await inspect(directory),
    records = rescored ?? view.records;
  const benchmark = registry.getBenchmark(view.plan.config.benchmark.adapter);
  const groups = [];
  const rows: Record<string, unknown>[] = [];
  for (const agent of view.plan.config.agents) {
    const selected = records.filter((r) => r.unit.agent_id === agent.id);
    const totals = {
      attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unknown_attempts: 0,
    };
    const sources = new Set<string>();
    let elapsed = 0;
    for (const r of selected) {
      const u = (await readSubmission(directory, r))?.submission.usage;
      if (u) {
        sources.add(u.source);
        for (const key of Object.keys(totals) as (keyof typeof totals)[])
          totals[key] += u[key];
      }
      elapsed += r.elapsed_ms;
      rows.push({
        evaluation_id: view.manifest.evaluation_id,
        score_id: scoreId,
        benchmark: benchmark.id,
        dataset_version: view.plan.config.benchmark.version,
        scoring_protocol: r.score?.protocol ?? benchmark.protocol,
        agent_config: agent.id,
        unit_id: r.unit.id,
        task_id: r.unit.task_id,
        repetition: r.unit.repetition,
        execution_status: r.execution_status,
        scoring_status: r.scoring_status,
        budget_status: r.budget_status,
        usage_source: u?.source ?? "unknown",
        usage_completeness: u
          ? u.unknown_attempts
            ? "unknown"
            : "complete"
          : "unknown",
        effective_budget: r.effective_budget,
        reason: r.reason,
        elapsed_ms: r.elapsed_ms,
        scoring_elapsed_ms: r.scoring_elapsed_ms ?? null,
        attempts: u?.attempts ?? null,
        total_tokens: u?.total_tokens ?? null,
        unknown_attempts: u?.unknown_attempts ?? null,
        ...Object.fromEntries(
          (r.score?.metrics ?? []).map((m) => [`metric_${m.name}`, m.value]),
        ),
      });
    }
    const protocols = new Set(
      selected.flatMap((r) => (r.score ? [r.score.protocol] : [])),
    );
    if (protocols.size > 1) throw new Error("Mixed scoring protocols");
    const scores = selected.flatMap((r) =>
      r.score?.status === "scored" ? [r.score] : [],
    );
    const compatibility = benchmark.compatibility
      ? await benchmark.compatibility(scores)
      : null;
    const missing = selected.some(
      (r) =>
        ["running", "unconfirmed"].includes(r.execution_status) ||
        (r.started_at !== null && r.submission_sha256 === null),
    );
    groups.push({
      benchmark: benchmark.id,
      dataset_version: view.plan.config.benchmark.version,
      protocol: [...protocols][0] ?? benchmark.protocol,
      agent_config: agent,
      ...aggregate(selected),
      usage: {
        ...totals,
        sources: [...sources],
        completeness:
          totals.unknown_attempts || missing ? "unknown" : "complete",
        currency_cost: "not_computed",
      },
      elapsed_ms: elapsed,
      scoring_elapsed_ms: selected.every(
        (r) => r.scoring_elapsed_ms !== undefined,
      )
        ? selected.reduce((n, r) => n + (r.scoring_elapsed_ms ?? 0), 0)
        : null,
      comparison_limits: [
        ...(selected.some((r) => r.budget_status !== "within")
          ? ["effective budget reduced, exceeded or unknown"]
          : []),
        ...(sources.has("self_reported") ? ["self-reported usage"] : []),
        ...(missing || totals.unknown_attempts
          ? ["incomplete cost telemetry"]
          : []),
        ...(!agent.require_seed ? ["seed control not required"] : []),
      ],
      upstream_compatible: compatibility
        ? {
            ...compatibility,
            planned: selected.length,
            scoring_coverage: scores.length / selected.length,
          }
        : null,
    });
  }
  const report = {
    schema_version: 1,
    score_id: scoreId,
    evaluation_id: view.manifest.evaluation_id,
    created_at: new Date().toISOString(),
    plan_sha256: view.plan.sha256,
    rescored: Boolean(rescored),
    scorer_version: benchmark.version,
    scoring_code: await codeSnapshot(),
    protocol: benchmark.protocol,
    groups,
    rows,
    scores: records.map((r) => ({ unit_id: r.unit.id, score: r.score })),
  };
  bounded(report, LIMITS.record);
  const destination = join(directory, "scores", id(scoreId));
  // The judge log may already live here; an existing report is never overwritten.
  await mkdir(destination, { recursive: true });
  if (await Bun.file(join(destination, "report.json")).exists())
    throw new Error("Score report already exists");
  await writeJson(join(destination, "report.json"), report);
  await writeFile(join(destination, "units.csv"), csv(rows), {
    flag: "wx",
    mode: 0o400,
  });
  return { score_id: scoreId, directory: destination, report };
}
export interface RescoreOptions {
  /** Judged protocols send paid requests; they run only with explicit permission and a fresh budget. */
  allowModelCalls?: boolean;
  judgeBudget?: { unit_budget: JudgeBudget; batch_budget: JudgeBudget };
  judgeFactory?: (profile: ModelProfile) => ModelClient;
}
export function parseJudgeBudget(value: unknown): {
  unit_budget: JudgeBudget;
  batch_budget: JudgeBudget;
} {
  const x = obj(value);
  keys(x, ["unit_budget", "batch_budget"]);
  return {
    unit_budget: validateJudgeBudget(x.unit_budget),
    batch_budget: validateJudgeBudget(x.batch_budget),
  };
}
export async function rescore(
  directory: string,
  registry: Registry,
  options: RescoreOptions = {},
) {
  const view = await inspect(directory),
    benchmark = registry.getBenchmark(view.plan.config.benchmark.adapter);
  const roles =
    benchmark.judgeRoles?.(view.plan.config.scoring?.options ?? {}) ?? [];
  // Refuse before reading benchmark data or contacting any judge.
  if (roles.length && (!options.allowModelCalls || !options.judgeBudget))
    throw new Error(
      "Judged rescoring sends paid model requests: pass --allow-model-calls and --judge-budget",
    );
  const catalog = await benchmark.catalog(view.plan.config.benchmark.options);
  if (catalog.provenance.version !== view.plan.config.benchmark.version)
    throw new Error("Rescore data version mismatch");
  for (const old of view.plan.tasks)
    if (
      JSON.stringify(
        validateTask(catalog.tasks.find((t) => t.id === old.id)),
      ) !== JSON.stringify(old)
    )
      throw new Error("Rescore task/input changed");
  await benchmark.preflight(
    view.plan.config.benchmark.options,
    view.plan.tasks,
  );
  const scoreId = randomUUID();
  const plan =
    roles.length && view.plan.config.scoring && options.judgeBudget
      ? {
          ...view.plan,
          config: {
            ...view.plan.config,
            scoring: { ...view.plan.config.scoring, ...options.judgeBudget },
          },
        }
      : view.plan;
  checkJudges(benchmark, plan.config.scoring);
  const session = judgeSession(
    plan,
    benchmark,
    join(directory, "scores", scoreId, "judge"),
    options.judgeFactory,
  );
  session?.preflight();
  const records: UnitRecord[] = [];
  for (const record of view.records) {
    const stored = await readSubmission(directory, record);
    if (
      !stored ||
      stored.submission.cleanup_error ||
      ["pending", "running", "unconfirmed", "not_run"].includes(
        record.execution_status,
      )
    ) {
      records.push(record);
      continue;
    }
    const next: UnitRecord = { ...record };
    await scoreUnit(
      plan,
      benchmark,
      next,
      stored.submission,
      stored.deliverables_root,
      session,
    );
    records.push(next);
  }
  return createReport(directory, registry, records, scoreId);
}
