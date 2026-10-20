"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ResultSummary,
  type RunSummary,
  type TraceEvent,
} from "../lib/api";
import { BACKEND_LABELS, formatTime, ORGANIZATION_LABELS } from "../lib/format";
import { BudgetPanel } from "./BudgetPanel";
import { FilesTab } from "./FilesTab";
import { ResultTab } from "./ResultTab";
import styles from "./Run.module.css";
import { StatusBadge } from "./StatusBadge";
import { Timeline } from "./Timeline";

type Tab = "trace" | "result" | "files";
type Connection = "connecting" | "open" | "reconnecting" | "closed";

interface StatusFrame {
  status: string;
  detail: string | null;
  cancellable: boolean;
}

const ACTIVE = new Set(["starting", "running", "finalizing"]);

export function RunView({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFrame | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [ended, setEnded] = useState(false);
  const [result, setResult] = useState<ResultSummary | null>(null);
  const [tab, setTab] = useState<Tab>("trace");
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [focusExecution, setFocusExecution] = useState<string | null>(null);
  // Highest sequence number shown; a reconnect resumes after it and anything at or below it is
  // dropped, so the timeline never shows an event twice.
  const lastSeq = useRef(0);

  const loadRun = useCallback(async () => {
    try {
      const { run } = await api.run(runId);
      setRun(run);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "读取失败");
    }
  }, [runId]);

  const loadResult = useCallback(async () => {
    try {
      setResult((await api.result(runId)).result);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "读取结果失败");
    }
  }, [runId]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    lastSeq.current = 0;
    setEvents([]);
    setEnded(false);
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events`,
    );
    source.onopen = () => setConnection("open");
    source.onerror = () => {
      // EventSource reconnects by itself and sends Last-Event-ID; only reflect the state.
      setConnection(
        source.readyState === EventSource.CLOSED ? "closed" : "reconnecting",
      );
    };
    source.addEventListener("trace", (message) => {
      const event = JSON.parse(
        (message as MessageEvent<string>).data,
      ) as TraceEvent;
      if (event.seq <= lastSeq.current) return;
      lastSeq.current = event.seq;
      setEvents((current) => [...current, event]);
    });
    source.addEventListener("status", (message) => {
      setStatus(JSON.parse((message as MessageEvent<string>).data));
    });
    source.addEventListener("end", (message) => {
      setStatus(JSON.parse((message as MessageEvent<string>).data));
      setEnded(true);
      setConnection("closed");
      // Without close() EventSource would reconnect after the server ends the stream.
      source.close();
    });
    source.addEventListener("stream_error", (message) => {
      setActionError(
        JSON.parse((message as MessageEvent<string>).data).error ??
          "读取轨迹失败",
      );
    });
    return () => source.close();
  }, [runId]);

  useEffect(() => {
    if (ended) {
      void loadRun();
      void loadResult();
    }
  }, [ended, loadRun, loadResult]);

  async function cancel() {
    if (!window.confirm("取消这次运行？已完成的轨迹与产物会保留。")) return;
    setCancelling(true);
    setActionError(null);
    try {
      await api.cancel(runId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "取消失败");
    } finally {
      setCancelling(false);
    }
  }

  const showExecution = useCallback((executionId: string) => {
    setTab("trace");
    setFocusExecution(executionId);
  }, []);

  if (loadError && !run)
    return (
      <div className="panel">
        <h1>运行 {runId}</h1>
        <div className="alert alert-error">{loadError}</div>
        <p>
          <Link href="/runs">返回运行历史</Link>
        </p>
      </div>
    );

  const current = status?.status ?? run?.status ?? "unknown";
  const detail = status ? status.detail : (run?.detail ?? null);
  const cancellable = status ? status.cancellable : (run?.cancellable ?? false);
  const organization = run?.organization ?? null;

  return (
    <div className={styles.page}>
      <header className={`panel ${styles.statusBar}`}>
        <div className={styles.statusMain}>
          <StatusBadge status={current} />
          <h1 className={styles.goal} title={run?.goal ?? ""}>
            {run?.goal ?? "加载中…"}
          </h1>
          {cancellable && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              {cancelling ? "正在取消…" : "取消运行"}
            </button>
          )}
        </div>
        <div className={styles.facts}>
          <span>运行 {runId.slice(0, 8)}</span>
          <span>
            {ORGANIZATION_LABELS[organization ?? ""] ?? organization ?? "—"}
          </span>
          <span>
            {BACKEND_LABELS[run?.backend ?? ""] ?? run?.backend ?? "—"}
          </span>
          <span>{run?.model ?? "—"}</span>
          <span>开始 {formatTime(run?.started_at)}</span>
          {ACTIVE.has(current) && connection === "reconnecting" && (
            <span className={styles.warnText}>连接中断，正在重连…</span>
          )}
        </div>
        {detail && <div className="alert alert-warn">{detail}</div>}
        {actionError && <div className="alert alert-error">{actionError}</div>}
      </header>

      <div className={styles.body}>
        <div className={styles.mainColumn}>
          <div className={styles.tabs} role="tablist">
            {(
              [
                ["trace", `轨迹（${events.length}）`],
                ["result", "结果"],
                ["files", "文件与成本"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`${styles.tab} ${tab === value ? styles.tabActive : ""}`}
                onClick={() => {
                  setTab(value);
                  if (value !== "trace" && !result) void loadResult();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div hidden={tab !== "trace"}>
            <Timeline
              runId={runId}
              events={events}
              collaboration={organization === "planner-executor"}
              live={!ended}
              focusExecution={focusExecution}
            />
          </div>
          {tab === "result" && (
            <ResultTab
              runId={runId}
              result={result}
              onShowExecution={showExecution}
            />
          )}
          {tab === "files" && <FilesTab runId={runId} result={result} />}
        </div>
        <aside className={styles.side}>
          <BudgetPanel events={events} />
        </aside>
      </div>
    </div>
  );
}
