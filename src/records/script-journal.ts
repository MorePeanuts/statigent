import { createHash } from "node:crypto";
import { identifier } from "../execution/protocol";
import { parseScriptMessage } from "../execution/script-protocol";
import { integer, obj, str } from "../models/validation";
export interface ScriptEntry {
  request_id: string;
  session_id: string;
  execution_id: string;
  execution_seq: number;
  code: string;
  sha256: string;
  status: string;
  started: boolean | null;
  result?: Record<string, unknown>;
  role?: unknown;
  subtask_id?: unknown;
}
export const sourceHash = (code: string) =>
  createHash("sha256").update(code).digest("hex");
export class ScriptJournal {
  readonly entries = new Map<string, ScriptEntry>();
  readonly reasons = new Set<string>();
  private executions = new Set<string>();
  private processes = new Set<string>();
  private sequence = 0;
  accept(event: Record<string, unknown>) {
    if (event.type === "journal_truncated") {
      this.reasons.add("journal_truncated");
      return;
    }
    if (
      ![
        "session_start",
        "ready",
        "dispatch",
        "output",
        "artifact",
        "finish",
        "interrupt",
        "close",
        "failure",
        "diagnostic",
      ].includes(String(event.type))
    )
      return;
    if (event.backend !== "fresh-script")
      throw Error("Script event backend mismatch");
    if (event.type === "ready" && event.initialization !== "script-init-v1")
      throw Error("Script initialization mismatch");
    if (event.type === "dispatch") {
      const r = obj(event.request);
      if (
        r.protocol_version !== 2 ||
        r.backend !== "fresh-script" ||
        r.type !== "execute" ||
        r.kernel_epoch !== undefined ||
        r.cell_id !== undefined
      )
        throw Error("Script dispatch protocol mismatch");
      for (const k of ["request_id", "session_id", "execution_id"])
        identifier(r[k], k);
      const id = str(r.request_id, "request_id"),
        execution = str(r.execution_id, "execution_id");
      if (this.entries.has(id) || this.executions.has(execution))
        throw Error("Duplicate script identity");
      if (typeof r.code !== "string") throw Error("Missing script source");
      const hash = sourceHash(r.code);
      if (event.code_sha256 !== hash || event.code !== r.code)
        throw Error("Script source checksum mismatch");
      this.executions.add(execution);
      this.entries.set(id, {
        request_id: id,
        session_id: str(r.session_id, "session_id"),
        execution_id: execution,
        execution_seq: integer(r.execution_seq, "execution_seq"),
        code: r.code,
        sha256: hash,
        status: "unknown",
        started: null,
        role: event.role,
        subtask_id: event.subtask_id,
      });
      return;
    }
    if (event.type === "output" || event.type === "artifact") {
      const m = obj(event.message);
      if (event.type === "artifact" && m.execution_id === undefined) return;
      const entry = this.entries.get(String(m.request_id));
      if (
        !entry ||
        entry.result ||
        m.execution_id !== entry.execution_id ||
        m.session_id !== entry.session_id ||
        m.execution_seq !== entry.execution_seq
      )
        throw Error("Script output identity mismatch");
      if (event.type === "output")
        parseScriptMessage(
          JSON.stringify(m),
          Number.MAX_SAFE_INTEGER,
          entry.session_id,
        );
      return;
    }
    if (event.type !== "finish") return;
    const r = obj(event.result);
    if (
      r.protocol_version !== 2 ||
      r.backend !== "fresh-script" ||
      r.kernel_epoch !== undefined ||
      r.cell_id !== undefined ||
      r.memory_preserved !== false ||
      r.files_policy !== "task-workspace"
    )
      throw Error("Script result metadata mismatch");
    const entry = this.entries.get(String(r.request_id));
    if (!entry) {
      if (
        r.started === false &&
        r.execution_seq === undefined &&
        r.status === "cancelled"
      )
        return;
      throw Error("Unattributed script result");
    }
    if (
      entry.result ||
      r.execution_id !== entry.execution_id ||
      r.session_id !== entry.session_id
    )
      throw Error("Script result identity mismatch");
    if (r.execution_seq !== undefined) {
      if (
        r.execution_seq !== entry.execution_seq ||
        r.execution_seq !== this.sequence + 1
      )
        throw Error("Script sequence mismatch");
      this.sequence++;
    } else if (
      r.started !== false ||
      r.process !== null ||
      r.status !== "cancelled"
    )
      throw Error("Invalid undispatched result");
    const wire: Record<string, unknown> = { type: "result" };
    for (const key of [
      "protocol_version",
      "backend",
      "request_id",
      "session_id",
      "execution_id",
      "execution_seq",
      "status",
      "started",
      "process",
      "session_available",
      "persistence_complete",
      "elapsed_ms",
      "timing",
      "error",
    ])
      if (r[key] !== undefined) wire[key] = r[key];
    wire.execution_seq ??= entry.execution_seq;
    parseScriptMessage(
      JSON.stringify(wire),
      Number.MAX_SAFE_INTEGER,
      entry.session_id,
    );
    if (r.process !== null) {
      const id = str(obj(r.process).instance_id, "process instance");
      if (this.processes.has(id)) throw Error("Reused script process");
      this.processes.add(id);
    }
    entry.result = r;
    entry.status = str(r.status, "status");
    entry.started = r.started === true;
    if (r.status !== "ok") this.reasons.add(`script_${String(r.status)}`);
    if (r.persistence_complete !== true)
      this.reasons.add("persistence_incomplete");
  }
  view() {
    const scripts = [...this.entries.values()];
    const reasons = new Set(this.reasons);
    if (!scripts.length) reasons.add("no_executed_scripts");
    if (scripts.some((s) => !s.result)) reasons.add("unfinished_execution");
    return { scripts, reasons: [...reasons], eligible: reasons.size === 0 };
  }
}
export function buildScripts(events: Record<string, unknown>[]) {
  const journal = new ScriptJournal();
  for (const event of events) journal.accept(event);
  return journal.view();
}
