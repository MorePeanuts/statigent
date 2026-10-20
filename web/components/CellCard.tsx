import type { TraceEvent } from "../lib/api";
import { artifactUrl } from "../lib/api";
import { formatDuration } from "../lib/format";
import { ArtifactContent } from "./ArtifactContent";
import styles from "./Run.module.css";

/** One code execution: what was dispatched, what it printed, and how it ended. */
export interface Execution {
  id: string;
  role: string | null;
  dispatch: TraceEvent | null;
  outputs: TraceEvent[];
  result: TraceEvent | null;
}

const STATUS_LABELS: Record<string, string> = {
  ok: "成功",
  error: "出错",
  timeout: "超时",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function CellCard({
  runId,
  execution,
  highlighted,
}: {
  runId: string;
  execution: Execution;
  highlighted: boolean;
}) {
  const { dispatch, result } = execution;
  const code = String(dispatch?.data.code ?? "");
  const lines = code.split("\n").length;
  const status =
    typeof result?.data.status === "string" ? result.data.status : null;
  const error = result?.data.error as { ename: string; evalue: string } | null;
  const artifacts = Object.values(result?.refs ?? {});
  const images = artifacts.filter((a) => a.mime_type?.startsWith("image/"));
  const files = artifacts.filter((a) => !a.mime_type?.startsWith("image/"));
  const inlineText = execution.outputs
    .map((o) => (typeof o.data.text === "string" ? o.data.text : ""))
    .join("");
  const preview =
    typeof result?.data.preview === "string" ? result.data.preview : "";

  return (
    <article
      id={`cell-${execution.id}`}
      className={`${styles.cell} ${highlighted ? styles.cellHighlight : ""}`}
    >
      <header className={styles.cellHead}>
        <span className={styles.seq}>#{dispatch?.seq ?? "?"}</span>
        <strong>执行 {String(dispatch?.data.execution_seq ?? "?")}</strong>
        {status === null ? (
          <span className="muted">执行中…</span>
        ) : (
          <span className={status === "ok" ? styles.okText : styles.errorText}>
            {STATUS_LABELS[status] ?? status}
          </span>
        )}
        {typeof result?.data.elapsed_ms === "number" && (
          <span className="muted">
            {formatDuration(result.data.elapsed_ms)}
          </span>
        )}
        {result?.data.partial_state_possible === true && (
          <span className={styles.warnText}>状态可能部分改变</span>
        )}
      </header>
      <details open={lines <= 15}>
        <summary className="muted">代码（{lines} 行）</summary>
        <pre>{code}</pre>
        {dispatch?.data.code_truncated === true && (
          <p className="muted">代码过长，仅显示前 64 KB。</p>
        )}
      </details>
      {inlineText ? (
        <pre className={styles.output}>{inlineText}</pre>
      ) : (
        preview && (
          <pre className={styles.output}>
            {preview}
            {result?.data.preview_truncated === true && "\n…（预览已截断）"}
          </pre>
        )
      )}
      {error && (
        <div className={styles.errorText}>
          {error.ename}: {error.evalue}
        </div>
      )}
      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((image) => (
            <a
              key={image.artifact_id}
              href={artifactUrl(runId, image.artifact_id)}
              target="_blank"
              rel="noreferrer"
              title={image.source_path ?? undefined}
            >
              {/* biome-ignore lint/performance/noImgElement: run artifacts are served by the local API, not optimised assets */}
              <img
                src={artifactUrl(runId, image.artifact_id)}
                alt={image.source_path ?? "图表"}
                className={styles.thumb}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className={styles.fileLinks}>
          {files.map((file) => (
            <a
              key={file.artifact_id}
              href={artifactUrl(runId, file.artifact_id)}
              target="_blank"
              rel="noreferrer"
            >
              {file.source_path ?? file.artifact_id.slice(0, 8)}
            </a>
          ))}
        </div>
      )}
      {execution.outputs.some((o) => o.refs.output) && (
        <div className={styles.fileLinks}>
          {execution.outputs
            .filter((o) => o.refs.output)
            .map((o, i) => (
              <ArtifactContent
                key={o.seq}
                runId={runId}
                artifact={o.refs.output as NonNullable<typeof o.refs.output>}
                label={`完整输出 ${i + 1}`}
              />
            ))}
        </div>
      )}
    </article>
  );
}
