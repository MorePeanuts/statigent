import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { methodIdSchema } from "../baselines/catalog";
import type { ModelClient } from "../models/client";
import type { ModelProfile } from "../models/config";
import { obj } from "../models/validation";
import { writeJson } from "../records/store";
import { aggregate } from "./aggregate";
import {
  bounded,
  id,
  LIMITS,
  type Submission,
  validateTask,
} from "./contracts";
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

function modelingColumns(
  options: Record<string, unknown>,
  record: UnitRecord,
  submission: Submission | undefined,
) {
  const details = record.score?.details ?? {},
    workflow = details.workflow ? obj(details.workflow) : null;
  const native = details.native ? obj(details.native) : null,
    metric = native?.metric ? obj(native.metric) : null;
  const identity = details.delivery_identity
    ? obj(details.delivery_identity)
    : null;
  const usage = workflow?.usage ? obj(workflow.usage) : null;
  const external = methodIdSchema.safeParse(options.method).success;
  return {
    method: options.method ?? "unspecified",
    search_end: workflow?.search_end ?? null,
    delivery_status:
      workflow?.delivery_status ?? (submission ? "not_delivered" : "not_run"),
    prediction_status:
      workflow?.prediction_status ?? (submission ? "not_delivered" : "not_run"),
    reproduction_status: "not_run",
    search_best_experiment_id: external
      ? "not_applicable"
      : (workflow?.search_best_experiment_id ?? null),
    selected_experiment_id: external
      ? "not_applicable"
      : (workflow?.selected_experiment_id ?? null),
    confirmation: external
      ? "not_applicable"
      : (workflow?.confirmation ?? null),
    ...(external
      ? {
          producer: identity?.producer ?? null,
          model_bundle: identity?.model_bundle ?? null,
        }
      : {}),
    native_metric: metric?.id ?? null,
    native_value: native?.value ?? null,
    native_direction: metric?.direction ?? null,
    native_components: native?.components ?? null,
    official: details.official ?? null,
    prediction_files: submission?.deliverables ?? [],
    native_identity: identity?.native_model ?? null,
    seed_preparation: identity?.execution_preparation ?? null,
    native_usage: usage,
    native_wall_ms: workflow?.wall_ms ?? null,
    cache_policy: "disabled",
    reproduction_cost: null,
  };
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
    const preflight = view.manifest.preflight[agent.id]
      ? obj(view.manifest.preflight[agent.id])
      : {};
    const selected = records.filter((r) => r.unit.agent_id === agent.id);
    const totals = {
      attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unknown_attempts: 0,
    };
    const sources = new Set<string>();
    // Judge usage is reported beside, never merged into, the agent's own usage.
    const judge = {
      attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unknown_attempts: 0,
      elapsed_ms: 0,
      self_preference_risk: false,
    };
    let elapsed = 0;
    for (const r of selected) {
      const submission = (await readSubmission(directory, r))?.submission;
      const u = submission?.usage;
      if (u) {
        sources.add(u.source);
        for (const key of Object.keys(totals) as (keyof typeof totals)[])
          totals[key] += u[key];
      }
      elapsed += r.elapsed_ms;
      const j = r.score?.judge ?? null;
      if (j) {
        for (const key of [
          "attempts",
          "input_tokens",
          "output_tokens",
          "total_tokens",
          "unknown_attempts",
          "elapsed_ms",
        ] as const)
          judge[key] += j[key];
        judge.self_preference_risk ||= j.self_preference_risk;
      }
      rows.push({
        evaluation_id: view.manifest.evaluation_id,
        score_id: scoreId,
        benchmark: benchmark.id,
        dataset_version: view.plan.config.benchmark.version,
        scoring_protocol: r.score?.protocol ?? benchmark.protocol,
        agent_config: agent.id,
        method: agent.options.method ?? "unspecified",
        ...(methodIdSchema.safeParse(agent.options.method).success
          ? {
              method_source:
                view.plan.baseline_methods?.[agent.id]?.source ?? "unknown",
              requested_method_config_hash:
                view.plan.baseline_methods?.[agent.id]?.config_hash ??
                "unknown",
              method_config_hash:
                typeof preflight.config_hash === "string"
                  ? preflight.config_hash
                  : "unknown",
              execution_conditions: {
                backend: agent.options.backend,
                image: preflight.image_id ?? "unknown",
                requested_image: agent.options.image,
                limits: agent.options.limits,
                model_profile: agent.model?.id ?? "not_applicable",
                internal_validation:
                  agent.adapter === "autogluon"
                    ? "five-fold-bagging-and-one-stack-level"
                    : "method-managed-training-only",
                delivery_reserve_ms: agent.options.delivery_reserve_ms,
                cache: "disabled",
              },
            }
          : {}),
        unit_id: r.unit.id,
        task_id: r.unit.task_id,
        repetition: r.unit.repetition,
        seed: r.unit.seed,
        ...(view.plan.tasks.find((t) => t.id === r.unit.task_id)?.output
          .kind === "predictions"
          ? modelingColumns(agent.options, r, submission)
          : {}),
        execution_status: r.execution_status,
        scoring_status: r.scoring_status,
        scoring_reason: r.scoring_reason ?? null,
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
        judge_protocol: j ? (r.score?.protocol ?? null) : null,
        judge_attempts: j?.attempts ?? null,
        judge_total_tokens: j?.total_tokens ?? null,
        judge_unknown_attempts: j?.unknown_attempts ?? null,
        self_preference_risk: j?.self_preference_risk ?? null,
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
      ...aggregate(selected, view.plan.groups, benchmark.summaries ?? []),
      usage: {
        ...totals,
        sources: [...sources],
        completeness:
          totals.unknown_attempts || missing ? "unknown" : "complete",
        currency_cost: "not_computed",
      },
      judge_usage: view.plan.config.scoring
        ? {
            ...judge,
            judges: Object.fromEntries(
              Object.entries(view.plan.config.scoring.judges).map(([r, p]) => [
                r,
                { profile: p.id, model: p.model },
              ]),
            ),
            nondeterministic: true,
            currency_cost: "not_computed",
          }
        : null,
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
        ...(judge.self_preference_risk
          ? ["judge shares the evaluated agent's model (self-preference risk)"]
          : []),
        ...(view.plan.config.scoring
          ? ["model-judged, non-deterministic scores"]
          : []),
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
  const x = z
    .strictObject({ unit_budget: z.unknown(), batch_budget: z.unknown() })
    .parse(value);
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
