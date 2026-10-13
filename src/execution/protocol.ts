/** Versioned JSONL contract. Container messages remain untrusted input. */
import { validBase64 } from "./base64";

export const PROTOCOL_VERSION = 1 as const;
export type TerminalStatus =
  | "ok"
  | "error"
  | "timed_out"
  | "cancelled"
  | "kernel_lost"
  | "output_limit_exceeded"
  | "protocol_error";
export type SessionState =
  | "starting"
  | "ready"
  | "busy"
  | "interrupting"
  | "restarting"
  | "failed"
  | "closing"
  | "closed";
export interface Limits {
  cpus: number;
  memory_bytes: number;
  pids: number;
  workspace_bytes: number;
  tmp_bytes: number;
  startup_timeout_ms: number;
  cell_timeout_ms: number;
  task_timeout_ms: number;
  interrupt_grace_ms: number;
  queue_capacity: number;
  max_code_bytes: number;
  max_frame_bytes: number;
  max_output_bytes: number;
  max_artifact_bytes: number;
  max_artifacts_bytes: number;
  preview_chars: number;
}
export const DEFAULT_LIMITS: Limits = {
  cpus: 1,
  memory_bytes: 1024 * 1024 * 1024,
  pids: 128,
  workspace_bytes: 64 * 1024 * 1024,
  tmp_bytes: 32 * 1024 * 1024,
  startup_timeout_ms: 30000,
  cell_timeout_ms: 30000,
  task_timeout_ms: 300000,
  interrupt_grace_ms: 3000,
  queue_capacity: 16,
  max_code_bytes: 128 * 1024,
  max_frame_bytes: 1024 * 1024,
  max_output_bytes: 8 * 1024 * 1024,
  max_artifact_bytes: 512 * 1024,
  max_artifacts_bytes: 16 * 1024 * 1024,
  preview_chars: 4000,
};
export interface SessionConfig {
  run_id: string;
  session_id?: string;
  image: string;
  input_root: string;
  inputs: string[];
  staging_root: string;
  seed: number;
  limits: Limits;
  platform?: string;
}
export interface BaseMessage {
  protocol_version: 1;
  request_id: string;
  session_id: string;
}
export interface CellIdentity {
  cell_id: string;
  kernel_epoch: number;
  execution_seq: number;
}
export type HostRequest = BaseMessage &
  (
    | { type: "init"; kernel_epoch: number; seed: number; limits: Limits }
    | ({ type: "execute"; code: string } & CellIdentity)
    | {
        type: "interrupt";
        target_request_id: string;
        reason: "timed_out" | "cancelled" | "output_limit_exceeded";
      }
    | { type: "restart"; kernel_epoch: number }
    | { type: "collect" }
    | { type: "shutdown" }
  );
export interface CodeError {
  ename: string;
  evalue: string;
  traceback: string[];
}
export type NotebookOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | ({ output_type: "error" } & CodeError)
  | {
      output_type: "display_data" | "execute_result" | "update_display_data";
      data: Record<string, string>;
      metadata: Record<string, unknown>;
      execution_count?: number;
      transient?: { display_id: string };
    }
  | { output_type: "clear_output"; wait: boolean };
export type BridgeMessage = BaseMessage &
  (
    | {
        type: "ready";
        kernel_epoch: number;
        kernel_available: boolean;
        dependencies: Record<string, string>;
      }
    | ({ type: "output"; output: NotebookOutput } & CellIdentity)
    | {
        type: "artifact";
        path: string;
        mime_type: string;
        data_base64: string;
        cell_id?: string;
        kernel_epoch: number;
        execution_seq?: number;
      }
    | ({
        type: "result";
        status: TerminalStatus;
        kernel_available: boolean;
        elapsed_ms: number;
        persistence_complete: boolean;
        error?: CodeError;
      } & CellIdentity)
    | {
        type: "control";
        operation: "interrupt" | "restart" | "collect" | "shutdown";
        kernel_epoch: number;
        kernel_available: boolean;
        files_preserved?: boolean;
        persistence_complete?: boolean;
        limit_exceeded?: boolean;
      }
    | {
        type: "diagnostic";
        message: string;
        kernel_epoch: number;
        cell_id?: string;
      }
  );
export interface ArtifactRef {
  artifact_id: string;
  path: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  complete: boolean;
}
export interface ExecutionResult {
  protocol_version: 1;
  request_id: string;
  session_id: string;
  cell_id: string;
  kernel_epoch: number;
  started: boolean;
  execution_seq?: number;
  status: TerminalStatus;
  elapsed_ms: number;
  waiting_ms: number;
  kernel_available: boolean;
  persistence_complete: boolean;
  preview: string;
  preview_truncated: boolean;
  artifacts: ArtifactRef[];
  error?: CodeError;
  diagnostic?: string;
  partial_state_possible: boolean;
}
export interface RuntimeEvent {
  type: string;
  at: string;
  run_id: string;
  session_id: string;
  [key: string]: unknown;
}
export interface SessionObserver {
  onEvent(event: RuntimeEvent): Promise<void>;
  onArtifact?(
    message: Extract<BridgeMessage, { type: "artifact" }>,
  ): Promise<ArtifactRef>;
}
export class ProtocolError extends Error {
  override name = "ProtocolError";
}
export function object(
  value: unknown,
  label = "object",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolError(`${label}: expected object`);
  return value as Record<string, unknown>;
}
export function identifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][-a-zA-Z0-9_.]{0,127}$/.test(value)
  )
    throw new ProtocolError(`${label}: invalid identifier`);
}
function str(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string")
    throw new ProtocolError(`${label}: expected string`);
}
function bool(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean")
    throw new ProtocolError(`${label}: expected boolean`);
}
function integer(
  value: unknown,
  label: string,
  min = 1,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new ProtocolError(`${label}: invalid integer`);
}
function error(value: unknown) {
  const x = object(value, "error");
  str(x.ename, "ename");
  str(x.evalue, "evalue");
  if (
    !Array.isArray(x.traceback) ||
    !x.traceback.every((v) => typeof v === "string")
  )
    throw new ProtocolError("traceback: expected strings");
}
export function validateConfig(value: unknown): SessionConfig {
  const x = object(value, "config");
  const allowed = new Set([
    "run_id",
    "session_id",
    "image",
    "input_root",
    "inputs",
    "staging_root",
    "seed",
    "limits",
    "platform",
  ]);
  for (const key of Object.keys(x))
    if (!allowed.has(key))
      throw new ProtocolError(`unknown config field: ${key}`);
  identifier(x.run_id, "run_id");
  if (x.session_id !== undefined) identifier(x.session_id, "session_id");
  for (const k of ["image", "input_root", "staging_root"]) {
    str(x[k], k);
    if (!(x[k] as string).length) throw new ProtocolError(`${k}: empty`);
  }
  if (!Array.isArray(x.inputs) || !x.inputs.every((v) => typeof v === "string"))
    throw new ProtocolError("inputs: expected paths");
  integer(x.seed, "seed", 0);
  const limits = object(x.limits, "limits");
  for (const key of Object.keys(limits))
    if (!(key in DEFAULT_LIMITS))
      throw new ProtocolError(`unknown limit: ${key}`);
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const v = limits[k];
    if (k === "cpus") {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
        throw new ProtocolError("cpus: invalid");
    } else integer(v, k);
  }
  if (
    (limits.max_code_bytes as number) * 6 + 1024 >
    (limits.max_frame_bytes as number)
  )
    throw new ProtocolError("max_frame_bytes must accommodate escaped code");
  if (
    x.platform !== undefined &&
    (typeof x.platform !== "string" ||
      !/^linux\/(amd64|arm64)$/.test(x.platform))
  )
    throw new ProtocolError("unsupported platform");
  return structuredClone(x) as unknown as SessionConfig;
}
export function validateOutput(value: unknown): NotebookOutput {
  const x = object(value, "output");
  switch (x.output_type) {
    case "stream":
      if (x.name !== "stdout" && x.name !== "stderr")
        throw new ProtocolError("invalid stream");
      str(x.text, "text");
      break;
    case "error":
      error(x);
      break;
    case "clear_output":
      bool(x.wait, "wait");
      break;
    case "display_data":
    case "execute_result":
    case "update_display_data": {
      const data = object(x.data, "data");
      for (const [k, v] of Object.entries(data)) {
        if (!["text/plain", "text/html", "image/png"].includes(k))
          throw new ProtocolError(`unsupported MIME ${k}`);
        str(v, k);
      }
      object(x.metadata, "metadata");
      if (x.output_type === "execute_result" && x.execution_count === undefined)
        throw new ProtocolError("execute_result requires execution_count");
      if (x.execution_count !== undefined)
        integer(x.execution_count, "execution_count", 0);
      if (x.transient !== undefined)
        str(object(x.transient).display_id, "display_id");
      break;
    }
    default:
      throw new ProtocolError("invalid output type");
  }
  return x as unknown as NotebookOutput;
}
export function parseBridgeMessage(
  line: string,
  maxBytes: number,
  sessionId: string,
): BridgeMessage {
  if (Buffer.byteLength(line) > maxBytes)
    throw new ProtocolError("message exceeds max_frame_bytes");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError("invalid JSON frame");
  }
  const x = object(value, "message");
  if (x.protocol_version !== 1)
    throw new ProtocolError("unsupported protocol_version");
  identifier(x.request_id, "request_id");
  if (x.session_id !== sessionId)
    throw new ProtocolError("session identity mismatch");
  integer(x.kernel_epoch, "kernel_epoch");
  if (x.type === "output" || x.type === "result") {
    identifier(x.cell_id, "cell_id");
    integer(x.execution_seq, "execution_seq");
  }
  switch (x.type) {
    case "ready":
      bool(x.kernel_available, "kernel_available");
      for (const v of Object.values(object(x.dependencies, "dependencies")))
        str(v, "dependency");
      break;
    case "output":
      validateOutput(x.output);
      break;
    case "artifact":
      str(x.path, "path");
      str(x.mime_type, "mime_type");
      str(x.data_base64, "data_base64");
      if (!validBase64(x.data_base64))
        throw new ProtocolError("invalid base64");
      if (x.cell_id !== undefined) identifier(x.cell_id, "cell_id");
      if (x.execution_seq !== undefined)
        integer(x.execution_seq, "execution_seq");
      break;
    case "result":
      if (
        ![
          "ok",
          "error",
          "timed_out",
          "cancelled",
          "kernel_lost",
          "output_limit_exceeded",
          "protocol_error",
        ].includes(String(x.status))
      )
        throw new ProtocolError("invalid terminal status");
      bool(x.kernel_available, "kernel_available");
      bool(x.persistence_complete, "persistence_complete");
      if (
        typeof x.elapsed_ms !== "number" ||
        !Number.isFinite(x.elapsed_ms) ||
        x.elapsed_ms < 0
      )
        throw new ProtocolError("invalid elapsed_ms");
      if (x.error !== undefined) error(x.error);
      break;
    case "control":
      if (
        !["interrupt", "restart", "collect", "shutdown"].includes(
          String(x.operation),
        )
      )
        throw new ProtocolError("invalid control");
      bool(x.kernel_available, "kernel_available");
      if (x.persistence_complete !== undefined)
        bool(x.persistence_complete, "persistence_complete");
      if (x.limit_exceeded !== undefined)
        bool(x.limit_exceeded, "limit_exceeded");
      if (x.files_preserved !== undefined)
        bool(x.files_preserved, "files_preserved");
      break;
    case "diagnostic":
      str(x.message, "message");
      break;
    default:
      throw new ProtocolError("unknown bridge message type");
  }
  return x as unknown as BridgeMessage;
}
