import { useState } from "react";
import type { ArtifactRefView } from "../../src/workbench/events";
import { artifactText, artifactUrl } from "../lib/api";
import { formatBytes } from "../lib/format";
import styles from "./Run.module.css";

const MAX_CHARS = 20_000;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function clip(text: string): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n…（已截断，共 ${text.length} 字符）`
    : text;
}

interface ToolCall {
  function?: { name?: string; arguments?: string };
}

/** A recorded model message: visible text, reasoning and the tool calls it made. */
function ModelMessage({ message }: { message: Record<string, unknown> }) {
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning =
    typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : "";
  const calls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as ToolCall[])
    : [];
  return (
    <div className={styles.modelMessage}>
      {reasoning && (
        <details>
          <summary className="muted">
            推理内容（{reasoning.length} 字符）
          </summary>
          <pre className={styles.small}>{clip(reasoning)}</pre>
        </details>
      )}
      {content && <pre className={styles.small}>{clip(content)}</pre>}
      {calls.map((call, i) => {
        let args: unknown = call.function?.arguments ?? "";
        try {
          args = JSON.parse(String(args));
        } catch {
          // Malformed arguments are shown as recorded; the agent rejected them itself.
        }
        const code =
          args && typeof args === "object" && "code" in args
            ? String((args as { code: unknown }).code)
            : null;
        return (
          <div key={`${call.function?.name}-${i}`}>
            <div className={styles.toolName}>
              调用工具 {call.function?.name ?? "?"}
            </div>
            <pre className={styles.small}>
              {clip(code ?? JSON.stringify(args, null, 2))}
            </pre>
          </div>
        );
      })}
      {!content && !reasoning && calls.length === 0 && (
        <p className="muted">（空消息）</p>
      )}
    </div>
  );
}

/** A Jupyter-style output message saved by the execution session. */
function OutputMessage({ output }: { output: Record<string, unknown> }) {
  const data = output.data as Record<string, unknown> | undefined;
  const traceback = Array.isArray(output.traceback)
    ? (output.traceback as string[]).join("\n")
    : null;
  const text =
    typeof output.text === "string"
      ? output.text
      : typeof data?.["text/plain"] === "string"
        ? (data["text/plain"] as string)
        : traceback
          ? `${output.ename ?? ""}: ${output.evalue ?? ""}\n${traceback}`
          : JSON.stringify(output, null, 2);
  return <pre className={styles.small}>{clip(text.replace(ANSI, ""))}</pre>;
}

function Rendered({ text }: { text: string }) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return <pre className={styles.small}>{clip(text)}</pre>;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.message && typeof record.message === "object")
      return (
        <ModelMessage message={record.message as Record<string, unknown>} />
      );
    if (typeof record.output_type === "string")
      return <OutputMessage output={record} />;
  }
  return (
    <pre className={styles.small}>{clip(JSON.stringify(value, null, 2))}</pre>
  );
}

export function ArtifactContent({
  runId,
  artifact,
  label,
}: {
  runId: string;
  artifact: ArtifactRefView;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const image = artifact.mime_type?.startsWith("image/");

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && text === null && !image) {
      try {
        setText(await artifactText(runId, artifact.artifact_id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "读取失败");
      }
    }
  }

  return (
    <div className={styles.artifact}>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => void toggle()}
      >
        {open ? "收起" : label}
        {artifact.size_bytes !== null && (
          <span className="muted"> · {formatBytes(artifact.size_bytes)}</span>
        )}
      </button>
      {open && (
        <div className={styles.artifactBody}>
          {image ? (
            <a
              href={artifactUrl(runId, artifact.artifact_id)}
              target="_blank"
              rel="noreferrer"
            >
              {/* biome-ignore lint/performance/noImgElement: run artifacts are served by the local API, not optimised assets */}
              <img
                src={artifactUrl(runId, artifact.artifact_id)}
                alt={artifact.source_path ?? "运行产物"}
                className={styles.image}
              />
            </a>
          ) : error ? (
            <div className="field-error">{error}</div>
          ) : text === null ? (
            <p className="muted">加载中…</p>
          ) : (
            <Rendered text={text} />
          )}
        </div>
      )}
    </div>
  );
}
