import type { GroupSummary } from "./contracts";
import type { UnitRecord } from "./records";

const UNFINISHED = ["pending", "running", "unconfirmed", "not_run"];
export function aggregate(
  records: UnitRecord[],
  groups: Record<string, string> = {},
  summaries: GroupSummary[] = [],
) {
  const scored = records.filter(
    (r) => r.scoring_status === "scored" && r.score?.status === "scored",
  );
  const complete =
    records.length > 0 &&
    scored.length === records.length &&
    records.every((r) => !UNFINISHED.includes(r.execution_status));
  const names = new Set(
    scored.flatMap((r) => r.score?.metrics.map((m) => m.name) ?? []),
  );
  const metrics: Record<string, number | null> = {};
  for (const name of names) {
    const values = scored.map((r) =>
      r.score?.metrics.find((m) => m.name === name),
    );
    if (values.some((m) => m === undefined))
      throw new Error("Inconsistent metric set");
    const definition = values[0];
    if (
      values.some(
        (m) =>
          m?.minimum !== definition?.minimum ||
          m?.maximum !== definition?.maximum ||
          m?.direction !== definition?.direction,
      )
    )
      throw new Error("Incompatible metrics");
    metrics[name] = complete
      ? values.reduce((n, m) => n + (m?.value ?? 0), 0) / records.length
      : null;
  }
  // Grouped metrics average within each group first, then across groups (e.g. DSBench case accuracy).
  const grouped: Record<string, number | null> = {};
  for (const summary of summaries) {
    const byGroup = new Map<string, UnitRecord[]>();
    for (const r of records) {
      const group = groups[r.unit.task_id];
      if (!group) throw new Error(`Missing group for task ${r.unit.task_id}`);
      byGroup.set(group, [...(byGroup.get(group) ?? []), r]);
    }
    const means: number[] = [];
    let incomplete = !byGroup.size;
    for (const members of byGroup.values()) {
      const values = members.map((r) =>
        r.scoring_status === "scored" &&
        r.score?.status === "scored" &&
        !UNFINISHED.includes(r.execution_status)
          ? r.score.metrics.find((m) => m.name === summary.metric)?.value
          : undefined,
      );
      if (values.some((v) => v === undefined)) {
        incomplete = true;
        break;
      }
      means.push(
        (values as number[]).reduce((a, b) => a + b, 0) / values.length,
      );
    }
    grouped[summary.name] = incomplete
      ? null
      : means.reduce((a, b) => a + b, 0) / means.length;
  }
  return {
    status: complete ? "complete" : "incomplete",
    planned: records.length,
    started: records.filter((r) => r.started_at !== null).length,
    scored: scored.length,
    coverage: records.length ? scored.length / records.length : 0,
    failed: records.filter((r) =>
      ["failed", "timed_out", "cancelled", "budget_exhausted"].includes(
        r.execution_status,
      ),
    ).length,
    not_scored: records.filter((r) => r.scoring_status === "not_scored").length,
    metrics,
    grouped,
  };
}
