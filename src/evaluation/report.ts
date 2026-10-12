import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../records/store";
import { aggregate } from "./aggregate";
import { bounded, LIMITS, type Score, validateScore } from "./contracts";
import type { Registry } from "./plan";
import { inspect, readSubmission, type UnitRecord } from "./records";

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
) {
  const view = await inspect(directory),
    records = rescored ?? view.records;
  const benchmark = registry.getBenchmark(view.plan.config.benchmark.adapter);
  const scoreId = randomUUID();
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
      const submission = await readSubmission(directory, r);
      const u = submission?.usage;
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
    protocol: benchmark.protocol,
    groups,
    rows,
    scores: records.map((r) => ({ unit_id: r.unit.id, score: r.score })),
  };
  bounded(report, LIMITS.record);
  const destination = join(directory, "scores", scoreId);
  await mkdir(destination);
  await writeJson(join(destination, "report.json"), report);
  await writeFile(join(destination, "units.csv"), csv(rows), {
    flag: "wx",
    mode: 0o400,
  });
  return { score_id: scoreId, directory: destination, report };
}
export async function rescore(directory: string, registry: Registry) {
  const view = await inspect(directory),
    benchmark = registry.getBenchmark(view.plan.config.benchmark.adapter);
  const catalog = await benchmark.catalog(view.plan.config.benchmark.options);
  if (catalog.provenance.version !== view.plan.config.benchmark.version)
    throw new Error("Rescore data version mismatch");
  for (const old of view.plan.tasks)
    if (
      JSON.stringify(catalog.tasks.find((t) => t.id === old.id)) !==
      JSON.stringify(old)
    )
      throw new Error("Rescore task/input changed");
  await benchmark.preflight(
    view.plan.config.benchmark.options,
    view.plan.tasks,
  );
  const records: UnitRecord[] = [];
  for (const record of view.records) {
    const submission = await readSubmission(directory, record);
    if (
      !submission ||
      submission.cleanup_error ||
      ["pending", "running", "unconfirmed", "not_run"].includes(
        record.execution_status,
      )
    ) {
      records.push(record);
      continue;
    }
    const task = view.plan.tasks.find((t) => t.id === record.unit.task_id);
    if (!task) throw new Error("Missing task");
    let score: Score;
    try {
      score = validateScore(
        await benchmark.score(
          view.plan.config.benchmark.options,
          task,
          submission,
        ),
        record.unit.id,
      );
    } catch (error) {
      score = {
        schema_version: 1,
        unit_id: record.unit.id,
        protocol: benchmark.protocol,
        status: "failed",
        metrics: [],
        details: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
    records.push({ ...record, score, scoring_status: score.status });
  }
  return createReport(directory, registry, records);
}
