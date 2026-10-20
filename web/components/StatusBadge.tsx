import styles from "./StatusBadge.module.css";

const LABELS: Record<string, string> = {
  starting: "启动中",
  running: "运行中",
  finalizing: "收尾中",
  completed: "已完成",
  budget_exhausted: "预算耗尽",
  timed_out: "已超时",
  cancelled: "已取消",
  failed: "失败",
  interrupted: "已中断",
  unknown: "状态未知",
};

const TONES: Record<string, string> = {
  starting: "active",
  running: "active",
  finalizing: "active",
  completed: "ok",
  budget_exhausted: "warn",
  timed_out: "warn",
  cancelled: "neutral",
  failed: "danger",
  interrupted: "danger",
  unknown: "neutral",
};

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = TONES[status] ?? "neutral";
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      {tone === "active" && <span className={styles.pulse} aria-hidden />}
      {statusLabel(status)}
    </span>
  );
}
