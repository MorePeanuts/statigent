import { integer, keys, obj, str } from "../models/validation";
import { validBase64 } from "./base64";
import {
  type ArtifactRef,
  type CodeError,
  type ExecutionResult,
  identifier,
  type Limits,
  type NotebookOutput,
  ProtocolError,
  validateOutput,
} from "./protocol";

export const SCRIPT_PROTOCOL_VERSION = 2 as const;
export const SCRIPT_INITIALIZATION = "script-init-v1";
export type ScriptStatus =
  | "ok"
  | "error"
  | "timed_out"
  | "cancelled"
  | "session_lost"
  | "output_limit_exceeded"
  | "protocol_error";
interface Base {
  protocol_version: 2;
  backend: "fresh-script";
  request_id: string;
  session_id: string;
}
export interface ScriptIdentity {
  execution_id: string;
  execution_seq: number;
}
export interface ScriptTiming {
  process_startup_ms: number | null;
  execution_ms: number | null;
  collection_ms: number | null;
  cleanup_ms: number | null;
}
export interface ScriptProcess {
  instance_id: string;
  pid: number;
}
export type ScriptRequest = Base &
  (
    | { type: "init"; seed: number; limits: Limits }
    | ({ type: "execute"; code: string } & ScriptIdentity)
    | {
        type: "interrupt";
        target_request_id: string;
        reason: "timed_out" | "cancelled" | "output_limit_exceeded";
      }
    | { type: "collect" | "shutdown" }
  );
export type ScriptMessage = Base &
  (
    | {
        type: "ready";
        session_available: boolean;
        initialization: typeof SCRIPT_INITIALIZATION;
        dependencies: Record<string, string>;
      }
    | ({ type: "output"; output: NotebookOutput } & ScriptIdentity)
    | {
        type: "artifact";
        path: string;
        mime_type: string;
        data_base64: string;
        execution_id?: string;
        execution_seq?: number;
      }
    | ({
        type: "result";
        status: ScriptStatus;
        started: boolean;
        process: ScriptProcess | null;
        session_available: boolean;
        persistence_complete: boolean;
        elapsed_ms: number;
        timing: ScriptTiming;
        error?: CodeError;
      } & ScriptIdentity)
    | {
        type: "control";
        operation: "interrupt" | "collect" | "shutdown";
        session_available: boolean;
        persistence_complete: boolean;
        limit_exceeded: boolean;
      }
    | { type: "diagnostic"; message: string }
  );
export type ScriptArtifact = Extract<ScriptMessage, { type: "artifact" }>;
export interface ScriptResult extends Base {
  execution_id: string;
  execution_seq?: number;
  started: boolean;
  process: ScriptProcess | null;
  status: ScriptStatus;
  elapsed_ms: number;
  waiting_ms: number;
  session_available: boolean;
  persistence_complete: boolean;
  memory_preserved: false;
  files_policy: "task-workspace";
  preview: string;
  preview_truncated: boolean;
  artifacts: ArtifactRef[];
  timing: ScriptTiming;
  error?: CodeError;
  diagnostic?: string;
  partial_state_possible: boolean;
}
export type BackendResult = ExecutionResult | ScriptResult;
export function executionId(result: BackendResult): string {
  return result.protocol_version === 1 ? result.cell_id : result.execution_id;
}
export function sessionAvailable(result: BackendResult): boolean {
  return result.protocol_version === 1
    ? result.kernel_available
    : result.session_available;
}
function boolean(value: unknown): void {
  if (typeof value !== "boolean") throw new ProtocolError("Expected boolean");
}
function duration(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new ProtocolError("Invalid duration");
}
const baseKeys = ["protocol_version", "backend", "request_id", "session_id"];
const identityKeys = ["execution_id", "execution_seq"];
export function parseScriptMessage(
  line: string,
  maxBytes: number,
  sessionId: string,
): ScriptMessage {
  if (Buffer.byteLength(line) > maxBytes)
    throw new ProtocolError("message exceeds max_frame_bytes");
  const x = obj(JSON.parse(line));
  if (x.protocol_version !== 2 || x.backend !== "fresh-script")
    throw new ProtocolError("Unsupported script protocol/backend");
  identifier(x.request_id, "request_id");
  if (x.session_id !== sessionId)
    throw new ProtocolError("session identity mismatch");
  let fields: string[];
  switch (x.type) {
    case "ready":
      fields = ["session_available", "initialization", "dependencies"];
      boolean(x.session_available);
      if (x.initialization !== SCRIPT_INITIALIZATION)
        throw new ProtocolError("Unsupported script initialization");
      for (const value of Object.values(obj(x.dependencies)))
        str(value, "dependency");
      break;
    case "output":
      fields = [...identityKeys, "output"];
      validateOutput(x.output);
      if (
        !["stream", "error", "display_data"].includes(
          String(obj(x.output).output_type),
        )
      )
        throw new ProtocolError("Unsupported script output");
      break;
    case "artifact":
      fields = [...identityKeys, "path", "mime_type", "data_base64"];
      str(x.path, "path");
      str(x.mime_type, "mime_type");
      if (typeof x.data_base64 !== "string" || !validBase64(x.data_base64))
        throw new ProtocolError("Invalid base64");
      if ((x.execution_id === undefined) !== (x.execution_seq === undefined))
        throw new ProtocolError("Incomplete artifact identity");
      break;
    case "result": {
      fields = [
        ...identityKeys,
        "status",
        "started",
        "process",
        "session_available",
        "persistence_complete",
        "elapsed_ms",
        "timing",
        "error",
      ];
      if (
        ![
          "ok",
          "error",
          "timed_out",
          "cancelled",
          "session_lost",
          "output_limit_exceeded",
          "protocol_error",
        ].includes(String(x.status))
      )
        throw new ProtocolError("Invalid script status");
      boolean(x.started);
      boolean(x.session_available);
      boolean(x.persistence_complete);
      duration(x.elapsed_ms);
      const timing = obj(x.timing);
      const timingKeys = [
        "process_startup_ms",
        "execution_ms",
        "collection_ms",
        "cleanup_ms",
      ];
      keys(timing, timingKeys);
      for (const key of timingKeys)
        if (timing[key] !== null) duration(timing[key]);
      if (x.process !== null) {
        const process = obj(x.process);
        keys(process, ["instance_id", "pid"]);
        identifier(process.instance_id, "instance_id");
        integer(process.pid, "pid");
      }
      if (x.started && x.process === null)
        throw new ProtocolError("Started execution requires process identity");
      if (
        x.status === "ok" &&
        (!x.started || !x.session_available || !x.persistence_complete)
      )
        throw new ProtocolError("Invalid successful script result");
      if (x.error !== undefined)
        validateOutput({ ...obj(x.error), output_type: "error" });
      break;
    }
    case "control":
      fields = [
        "operation",
        "session_available",
        "persistence_complete",
        "limit_exceeded",
      ];
      if (!["interrupt", "collect", "shutdown"].includes(String(x.operation)))
        throw new ProtocolError("Invalid script control");
      boolean(x.session_available);
      boolean(x.persistence_complete);
      boolean(x.limit_exceeded);
      break;
    case "diagnostic":
      fields = ["message"];
      str(x.message, "message");
      break;
    default:
      throw new ProtocolError("Unknown script message");
  }
  keys(x, [...baseKeys, "type", ...fields]);
  if (
    x.type === "result" ||
    x.type === "output" ||
    x.execution_id !== undefined
  ) {
    identifier(x.execution_id, "execution_id");
    integer(x.execution_seq, "execution_seq");
  }
  return x as unknown as ScriptMessage;
}
