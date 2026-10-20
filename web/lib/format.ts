export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : value.toLocaleString("zh-CN");
}

export function truncate(text: string | null | undefined, length: number) {
  if (!text) return "";
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export const ORGANIZATION_LABELS: Record<string, string> = {
  single: "单智能体",
  "planner-executor": "规划—执行",
};

export const BACKEND_LABELS: Record<string, string> = {
  "persistent-kernel": "持久内核",
  "fresh-script": "独立脚本",
};
