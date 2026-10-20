"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type RunListError, type RunSummary } from "../lib/api";
import {
  BACKEND_LABELS,
  formatNumber,
  formatTime,
  ORGANIZATION_LABELS,
  truncate,
} from "../lib/format";
import styles from "./Runs.module.css";
import { StatusBadge } from "./StatusBadge";

export function RunsTable() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [errors, setErrors] = useState<RunListError[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.runs();
      setRuns(result.runs);
      setErrors(result.errors);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "读取失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="panel">
      <div className={styles.header}>
        <h1>运行历史</h1>
        <span className="muted">
          只包含工作台发起的运行（runs/workbench）。
        </span>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => void load()}
        >
          刷新
        </button>
      </div>
      {loadError && <div className="alert alert-error">{loadError}</div>}
      {runs === null && !loadError && <p className="muted">加载中…</p>}
      {runs?.length === 0 && errors.length === 0 && (
        <p className="muted">
          还没有运行。<Link href="/">新建一次分析</Link>
        </p>
      )}
      {runs && runs.length > 0 && (
        <div className={styles.scroll}>
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>分析目标</th>
                <th>组织</th>
                <th>后端</th>
                <th>模型</th>
                <th>token</th>
                <th>执行</th>
                <th>开始时间</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id}>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td className={styles.goal}>
                    <Link
                      href={`/runs/${run.run_id}`}
                      title={run.goal ?? run.run_id}
                    >
                      {truncate(run.goal, 90) || run.run_id}
                    </Link>
                    {run.detail && (
                      <div className={styles.detail}>
                        {truncate(run.detail, 140)}
                      </div>
                    )}
                  </td>
                  <td>
                    {ORGANIZATION_LABELS[run.organization ?? ""] ??
                      run.organization ??
                      "—"}
                  </td>
                  <td>
                    {BACKEND_LABELS[run.backend ?? ""] ?? run.backend ?? "—"}
                  </td>
                  <td>{run.model ?? "—"}</td>
                  <td className={styles.number}>
                    {run.tokens ? formatNumber(run.tokens.total) : "—"}
                    {run.tokens && !run.tokens.known && (
                      <span className="muted">*</span>
                    )}
                  </td>
                  <td className={styles.number}>
                    {formatNumber(run.executions)}
                  </td>
                  <td className={styles.time}>{formatTime(run.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {errors.length > 0 && (
        <div className={styles.errors}>
          <h2>无法读取的记录（{errors.length}）</h2>
          <p className="muted">
            这些目录的运行记录损坏或不完整，未影响其他运行的列出。
          </p>
          <ul>
            {errors.map((error) => (
              <li key={error.run_id}>
                <code>{error.run_id}</code>：{error.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
