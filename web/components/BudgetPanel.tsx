import type { TraceEvent } from "../lib/api";
import { formatDuration, formatNumber } from "../lib/format";
import styles from "./Run.module.css";

interface Remaining {
  model_attempts: number;
  executions: number;
  tokens: number;
  task_ms: number;
}

function remainingOf(event: TraceEvent | undefined): Remaining | null {
  const value = event?.data.remaining;
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  return typeof r.model_attempts === "number" &&
    typeof r.executions === "number" &&
    typeof r.tokens === "number" &&
    typeof r.task_ms === "number"
    ? (r as unknown as Remaining)
    : null;
}

/**
 * Budget as the agent recorded it before each model call. The first check approximates the
 * starting budget; the latest one is what was left at that point.
 */
export function BudgetPanel({ events }: { events: TraceEvent[] }) {
  const checks = events.filter((e) => e.type === "agent_budget");
  const first = remainingOf(checks[0]);
  const latest = remainingOf(checks.at(-1));
  let tokens = 0;
  let unknownUsage = 0;
  let responses = 0;
  for (const event of events) {
    if (event.type !== "model_response") continue;
    responses++;
    const usage = event.data.usage as { total_tokens?: number | null } | null;
    if (typeof usage?.total_tokens === "number") tokens += usage.total_tokens;
    else unknownUsage++;
  }
  const executions = events.filter((e) => e.kind === "result").length;

  const rows: [string, number | null, number | null, (n: number) => string][] =
    [
      [
        "模型调用",
        latest?.model_attempts ?? null,
        first?.model_attempts ?? null,
        formatNumber,
      ],
      [
        "代码执行",
        latest?.executions ?? null,
        first?.executions ?? null,
        formatNumber,
      ],
      ["token", latest?.tokens ?? null, first?.tokens ?? null, formatNumber],
      ["时间", latest?.task_ms ?? null, first?.task_ms ?? null, formatDuration],
    ];

  return (
    <section className="panel" aria-label="预算">
      <h2>预算</h2>
      {!latest ? (
        <p className="muted">尚无预算记录。</p>
      ) : (
        <div className={styles.budget}>
          {rows.map(([label, left, total, format]) => {
            const ratio =
              left !== null && total
                ? Math.max(0, Math.min(1, left / total))
                : 0;
            return (
              <div key={label}>
                <div className={styles.budgetLabel}>
                  <span>{label}剩余</span>
                  <span>
                    {left === null ? "—" : format(left)}
                    <span className="muted">
                      {" "}
                      / {total === null ? "—" : format(total)}
                    </span>
                  </span>
                </div>
                <div className={styles.meter} aria-hidden>
                  <div
                    className={`${styles.meterFill} ${ratio < 0.2 ? styles.meterLow : ""}`}
                    style={{ width: `${ratio * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
          <p className={styles.budgetNote}>
            剩余量取自每次模型调用前的记录，最后一次调用之后的消耗不在其中。
          </p>
        </div>
      )}
      <h3 style={{ marginTop: 16 }}>已用</h3>
      <dl className={styles.stats}>
        <dt>模型响应</dt>
        <dd>{responses}</dd>
        <dt>代码执行</dt>
        <dd>{executions}</dd>
        <dt>累计 token</dt>
        <dd>
          {formatNumber(tokens)}
          {unknownUsage > 0 && (
            <span className="muted">（{unknownUsage} 次用量未知）</span>
          )}
        </dd>
      </dl>
    </section>
  );
}
