import { type DragEvent, useRef, useState } from "react";
import { api, type InputFile } from "../lib/api";
import { formatBytes } from "../lib/format";
import styles from "./Workbench.module.css";

const ACCEPT = ".csv,.tsv,.xlsx,.json,.parquet";

export function InputsPanel(props: {
  inputs: InputFile[];
  error: string | null;
  selected: string[];
  onSelectedChange: (names: string[]) => void;
  onChanged: () => Promise<void>;
}) {
  const { inputs, selected, onSelectedChange, onChanged } = props;
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function upload(files: FileList | File[]) {
    setBusy(true);
    setMessage(null);
    const failures: string[] = [];
    const added: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const { input } = await api.upload(file);
        added.push(input.name);
      } catch (error) {
        failures.push(
          `${file.name}：${error instanceof Error ? error.message : "上传失败"}`,
        );
      }
    }
    // Newly uploaded files are selected for the next run.
    if (added.length) onSelectedChange([...new Set([...selected, ...added])]);
    await onChanged();
    setBusy(false);
    if (failures.length) setMessage(failures.join("\n"));
  }

  async function remove(name: string) {
    if (!window.confirm(`从输入区删除 ${name}？已完成的运行不受影响。`)) return;
    try {
      await api.deleteInput(name);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    }
  }

  function toggle(name: string) {
    onSelectedChange(
      selected.includes(name)
        ? selected.filter((n) => n !== name)
        : [...selected, name],
    );
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
  }

  return (
    <section className={`panel ${styles.section}`} aria-label="输入数据">
      <div className={styles.sectionHeader}>
        <h2>输入数据</h2>
        <span className={styles.meta}>已选 {selected.length}</span>
      </div>
      <button
        type="button"
        className={`${styles.drop} ${dragging ? styles.dropActive : ""}`}
        onClick={() => picker.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        disabled={busy}
      >
        {busy ? "上传中…" : "点击或拖入文件上传"}
        <span className={styles.hint} style={{ display: "block" }}>
          CSV / TSV / XLSX / JSON / Parquet
        </span>
      </button>
      <input
        ref={picker}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) void upload(event.target.files);
          event.target.value = "";
        }}
      />
      {message && (
        <div className="alert alert-error" style={{ whiteSpace: "pre-line" }}>
          {message}
        </div>
      )}
      {props.error && <div className="alert alert-error">{props.error}</div>}
      {inputs.length === 0 ? (
        <p className="muted">
          输入区为空。上传的文件只保存在本机 runs/workbench/inputs。
        </p>
      ) : (
        <ul className={styles.list}>
          {inputs.map((file) => {
            const active = selected.includes(file.name);
            return (
              <li
                key={file.name}
                className={`${styles.fileRow} ${active ? styles.fileSelected : ""}`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggle(file.name)}
                  aria-label={`选择 ${file.name}`}
                />
                <div style={{ minWidth: 0 }}>
                  <div className={styles.fileName} title={file.name}>
                    {file.name}
                  </div>
                  <div className={styles.meta} title={`sha256 ${file.sha256}`}>
                    {formatBytes(file.size_bytes)} · {file.sha256.slice(0, 10)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void remove(file.name)}
                  aria-label={`删除 ${file.name}`}
                >
                  删除
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
