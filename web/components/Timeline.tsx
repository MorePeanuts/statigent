import { useEffect, useMemo, useState } from "react";
import type { TraceEvent } from "../lib/api";
import { formatDuration, formatNumber } from "../lib/format";
import { ArtifactContent } from "./ArtifactContent";
import { CellCard, type Execution } from "./CellCard";
import styles from "./Run.module.css";

type Item =
  | { kind: "event"; event: TraceEvent }
  | { kind: "cell"; execution: Execution }
  | { kind: "subtask"; id: string; index: number; items: Item[] };

// Low-level bookkeeping that the detailed view shows but the default view folds away.
const DETAIL_TYPES = new Set([
  "agent_budget",
  "model_request",
  "tool_validation",
  "output",
  "finish",
  "dispatch",
  "artifact",
  "artifact_saved",
]);

function buildExecutions(events: TraceEvent[]): Map<string, Execution> {
  const executions = new Map<string, Execution>();
  for (const event of events) {
    if (!event.execution_id) continue;
    if (!["code", "output", "result"].includes(event.kind)) continue;
    const execution = executions.get(event.execution_id) ?? {
      id: event.execution_id,
      role: event.role,
      dispatch: null,
      outputs: [],
      result: null,
    };
    if (event.kind === "code") execution.dispatch = event;
    if (event.kind === "output") execution.outputs.push(event);
    if (event.kind === "result") execution.result = event;
    executions.set(event.execution_id, execution);
  }
  return executions;
}

/** Orders items as recorded; executor work of a collaboration run nests under its subtask. */
function buildItems(
  events: TraceEvent[],
  collaboration: boolean,
  detailed: boolean,
): Item[] {
  const executions = buildExecutions(events);
  const top: Item[] = [];
  const subtasks = new Map<string, Item & { kind: "subtask" }>();
  const place = (event: TraceEvent, item: Item) => {
    const nested =
      collaboration &&
      event.subtask_id &&
      (event.role === "executor" || event.kind === "delegation");
    if (!nested || !event.subtask_id) {
      top.push(item);
      return;
    }
    let block = subtasks.get(event.subtask_id);
    if (!block) {
      block = {
        kind: "subtask",
        id: event.subtask_id,
        index: subtasks.size + 1,
        items: [],
      };
      subtasks.set(event.subtask_id, block);
      top.push(block);
    }
    block.items.push(item);
  };
  for (const event of events) {
    // A cell appears once, where its code was dispatched.
    if (event.kind === "code" && event.execution_id) {
      const execution = executions.get(event.execution_id);
      if (execution) place(event, { kind: "cell", execution });
      if (!detailed) continue;
    }
    if (!detailed) {
      if (DETAIL_TYPES.has(event.type)) {
        // Rejected tool calls matter even in the compact view.
        if (!(event.type === "tool_validation" && event.data.valid === false))
          continue;
      }
    }
    place(event, { kind: "event", event });
  }
  return top;
}

const ROLE_LABELS: Record<string, string> = {
  planner: "规划者",
  executor: "执行者",
};

function EventRow({ runId, event }: { runId: string; event: TraceEvent }) {
  const usage = event.data.usage as
    | { total_tokens?: number | null; output_tokens?: number | null }
    | null
    | undefined;
  const ref =
    event.refs.content ??
    event.refs.feedback ??
    event.refs.output ??
    event.refs.report ??
    event.refs.artifact;
  const tone =
    event.kind === "finish"
      ? styles.rowFinish
      : event.data.valid === false || event.kind === "diagnostic"
        ? styles.rowWarn
        : "";
  return (
    <div className={`${styles.row} ${tone}`}>
      <div className={styles.rowHead}>
        <span className={styles.seq}>#{event.seq}</span>
        {event.role && (
          <span className={`${styles.role} ${styles[event.role] ?? ""}`}>
            {ROLE_LABELS[event.role] ?? event.role}
          </span>
        )}
        <span className={styles.rowSummary}>{event.summary}</span>
        {typeof usage?.total_tokens === "number" && (
          <span className="muted">
            {formatNumber(usage.total_tokens)} token
          </span>
        )}
        {typeof event.data.elapsed_ms === "number" && (
          <span className="muted">{formatDuration(event.data.elapsed_ms)}</span>
        )}
      </div>
      {typeof event.data.diagnostic === "string" && event.data.diagnostic && (
        <pre className={styles.small}>{event.data.diagnostic}</pre>
      )}
      {ref && (
        <ArtifactContent
          runId={runId}
          artifact={ref}
          label={
            event.type === "model_response"
              ? "查看模型输出"
              : event.type === "model_request"
                ? "查看请求内容"
                : event.kind === "delegation"
                  ? "查看内容"
                  : "查看"
          }
        />
      )}
    </div>
  );
}

/** What the run is doing now, judged from its last recorded event. */
function liveHint(events: TraceEvent[]): string {
  const last = [...events]
    .reverse()
    .find((e) => e.type !== "agent_budget" && e.type !== "tool_validation");
  if (last?.type === "model_request")
    return `等待${last.role ? (ROLE_LABELS[last.role] ?? "") : ""}模型响应…`;
  if (last?.kind === "code" || last?.kind === "output") return "代码执行中…";
  return "运行中，新事件会自动出现…";
}

export function Timeline(props: {
  runId: string;
  events: TraceEvent[];
  collaboration: boolean;
  live: boolean;
  focusExecution: string | null;
}) {
  const { runId, events, collaboration, live, focusExecution } = props;
  const [detailed, setDetailed] = useState(false);
  const items = useMemo(
    () => buildItems(events, collaboration, detailed),
    [events, collaboration, detailed],
  );

  useEffect(() => {
    if (!focusExecution) return;
    document
      .getElementById(`cell-${focusExecution}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusExecution]);

  const render = (item: Item, key: string) => {
    if (item.kind === "cell")
      return (
        <CellCard
          key={key}
          runId={runId}
          execution={item.execution}
          highlighted={item.execution.id === focusExecution}
        />
      );
    if (item.kind === "subtask")
      return (
        <details key={key} className={styles.subtask} open>
          <summary>
            <span className={`${styles.role} ${styles.executor}`}>执行者</span>
            子任务 {item.index}
            <span className="muted"> · {item.items.length} 项</span>
          </summary>
          <div className={styles.subtaskBody}>
            {item.items.map((child, i) => render(child, `${key}-${i}`))}
          </div>
        </details>
      );
    return <EventRow key={key} runId={runId} event={item.event} />;
  };

  return (
    <section className={styles.timeline} aria-label="运行轨迹">
      <div className={styles.timelineTools}>
        <label>
          <input
            type="checkbox"
            checked={detailed}
            onChange={(e) => setDetailed(e.target.checked)}
          />{" "}
          显示全部记录事件
        </label>
        <span className="muted">
          {collaboration ? "规划—执行：执行者的工作按子任务归组" : "单智能体"}
        </span>
      </div>
      {events.length === 0 && (
        <p className="muted">
          {live ? "等待轨迹写入…" : "这次运行没有轨迹记录。"}
        </p>
      )}
      {items.map((item, i) => render(item, String(i)))}
      {live && events.length > 0 && (
        <p className={styles.liveHint}>{liveHint(events)}</p>
      )}
    </section>
  );
}
