import type { UnitRecord } from "./records";

export function aggregate(records: UnitRecord[]) {
  const scored = records.filter(
    (r) => r.scoring_status === "scored" && r.score?.status === "scored",
  );
  const complete =
    records.length > 0 &&
    scored.length === records.length &&
    records.every(
      (r) =>
        !["pending", "running", "unconfirmed", "not_run"].includes(
          r.execution_status,
        ),
    );
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
    metrics,
  };
}
