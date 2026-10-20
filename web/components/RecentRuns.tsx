import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type RunSummary } from "../lib/api";
import { formatTime, ORGANIZATION_LABELS, truncate } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import styles from "./Workbench.module.css";

export function RecentRuns() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .runs()
      .then(({ runs }) => setRuns(runs.slice(0, 8)))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "读取失败"),
      );
  }, []);

  return (
    <section className={`panel ${styles.section}`} aria-label="最近运行">
      <div className={styles.sectionHeader}>
        <h2>最近运行</h2>
        <Link href="/runs" className={styles.meta}>
          全部
        </Link>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {runs === null && !error && <p className="muted">加载中…</p>}
      {runs?.length === 0 && <p className="muted">还没有运行。</p>}
      <div>
        {runs?.map((run) => (
          <Link
            key={run.run_id}
            href={`/runs/${run.run_id}`}
            className={styles.runItem}
          >
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <StatusBadge status={run.status} />
              <span className={styles.meta}>{formatTime(run.started_at)}</span>
            </span>
            <span className={styles.runGoal}>
              {truncate(run.goal, 120) || "（无目标记录）"}
            </span>
            <span className={styles.meta}>
              {ORGANIZATION_LABELS[run.organization ?? ""] ??
                run.organization ??
                "—"}
              {" · "}
              {run.model ?? "—"}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
