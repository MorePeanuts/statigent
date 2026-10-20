import { open } from "node:fs/promises";
import * as z from "zod";

// Turns the agent's append-only events.jsonl into a compact, ordered view for the browser. The
// view only selects and labels recorded fields; it never invents model output. Large content
// (model messages, execution output) stays in run artifacts and is referenced, not inlined.

export type TraceKind =
  | "session"
  | "budget"
  | "model"
  | "tool"
  | "delegation"
  | "code"
  | "output"
  | "result"
  | "artifact"
  | "analysis"
  | "finish"
  | "diagnostic"
  | "generic";

export interface ArtifactRefView {
  artifact_id: string;
  mime_type: string | null;
  size_bytes: number | null;
  source_path: string | null;
}

export interface TraceEvent {
  /** 1-based line number in events.jsonl; also the SSE event ID. */
  seq: number;
  at: string | null;
  type: string;
  kind: TraceKind;
  /** planner / executor in collaboration runs; null for a single agent and session events. */
  role: string | null;
  subtask_id: string | null;
  /** Persistent kernel cell ID or fresh-script execution ID. */
  execution_id: string | null;
  attempt_id: string | null;
  summary: string;
  data: Record<string, unknown>;
  refs: Record<string, ArtifactRefView>;
}

const MAX_CODE_CHARS = 64 * 1024;
const MAX_TEXT_CHARS = 4000;

const nullableString = z.string().nullish();
const ref = z
  .object({
    artifact_id: z.string(),
    mime_type: z.string().optional(),
    size_bytes: z.number().optional(),
    source_path: z.string().nullish(),
  })
  .loose();

const base = {
  at: z.string().optional(),
  role: nullableString,
  subtask_id: nullableString,
  attempt_id: nullableString,
};

const usage = z
  .object({
    status: z.string().optional(),
    input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish(),
    total_tokens: z.number().nullish(),
  })
  .loose();

const known = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("session_start"),
      config: z
        .object({ backend: z.string().optional(), image: z.string() })
        .loose(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("ready"),
      kernel_epoch: z.number().optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("agent_budget"),
      remaining: z
        .object({
          model_attempts: z.number(),
          executions: z.number(),
          tokens: z.number(),
          task_ms: z.number(),
        })
        .loose(),
      max_output_tokens: z.number().optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("model_request"),
      requested_model: z.string().optional(),
      input_estimate: z.number().optional(),
      content_ref: ref.optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("model_response"),
      returned_model: nullableString,
      usage: usage.optional(),
      elapsed_ms: z.number().optional(),
      content_ref: ref.optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("model_failure"),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("tool_validation"),
      // Three records share this type: the action check (valid), the durable dispatch intent
      // (dispatched) and the execution feedback sent back to the model (content_ref).
      valid: z.boolean().optional(),
      dispatched: z.boolean().optional(),
      diagnostic: z.unknown().optional(),
      tool_id: nullableString,
      request_id: nullableString,
      cell_id: nullableString,
      execution_id: nullableString,
      content_ref: ref.optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.enum(["subtask_delegated", "subtask_returned"]),
      content_ref: ref.optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("dispatch"),
      request: z
        .object({
          request_id: z.string(),
          code: z.string().optional(),
          cell_id: z.string().optional(),
          execution_id: z.string().optional(),
          execution_seq: z.number().optional(),
          kernel_epoch: z.number().optional(),
        })
        .loose(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("output"),
      message: z
        .object({
          request_id: z.string().optional(),
          cell_id: z.string().optional(),
          execution_id: z.string().optional(),
          output_type: z.string().optional(),
          name: z.string().optional(),
          text: z.string().optional(),
        })
        .loose(),
      output_ref: ref.optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.literal("finish"),
      result: z
        .object({
          request_id: z.string(),
          status: z.string(),
          cell_id: z.string().optional(),
          execution_id: z.string().optional(),
          execution_seq: z.number().optional(),
          elapsed_ms: z.number().optional(),
          preview: z.string().optional(),
          preview_truncated: z.boolean().optional(),
          partial_state_possible: z.boolean().optional(),
          error: z
            .object({ ename: z.string(), evalue: z.string() })
            .loose()
            .optional(),
          artifacts: z.array(ref).optional(),
        })
        .loose(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.enum(["artifact", "artifact_saved"]),
      artifact: ref,
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.enum(["analysis_submitted", "analysis_closing", "report_saved"]),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.enum(["agent_finish", "run_finished"]),
      status: z.string(),
      reason: z.string().optional(),
    })
    .loose(),
  z
    .object({
      ...base,
      type: z.enum([
        "interrupt",
        "restart",
        "close",
        "failure",
        "diagnostic",
        "model_trace_limit",
      ]),
    })
    .loose(),
]);

function clip(text: string, limit: number) {
  return text.length > limit
    ? { text: text.slice(0, limit), truncated: true }
    : { text, truncated: false };
}

function refView(value: z.infer<typeof ref>): ArtifactRefView {
  return {
    artifact_id: value.artifact_id,
    mime_type: value.mime_type ?? null,
    size_bytes: value.size_bytes ?? null,
    source_path: value.source_path ?? null,
  };
}

/** Small scalar fields of an event, for types the view does not model in detail. */
function scalars(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["type", "at", "run_id", "session_id"].includes(key)) continue;
    if (typeof value === "string") out[key] = clip(value, 500).text;
    else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    )
      out[key] = value;
  }
  return out;
}

function generic(
  seq: number,
  raw: Record<string, unknown>,
  kind: TraceKind = "generic",
  summary?: string,
): TraceEvent {
  const text = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string) : null;
  return {
    seq,
    at: text("at"),
    type: text("type") ?? "unknown",
    kind,
    role: text("role"),
    subtask_id: text("subtask_id"),
    execution_id: text("cell_id") ?? text("execution_id"),
    attempt_id: text("attempt_id"),
    summary: summary ?? `Event ${text("type") ?? "without type"}`,
    data: scalars(raw),
    refs: {},
  };
}

export function normalizeEvent(seq: number, raw: unknown): TraceEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return generic(seq, {}, "diagnostic", "Trace line is not a JSON object");
  const record = raw as Record<string, unknown>;
  const parsed = known.safeParse(record);
  if (!parsed.success) return generic(seq, record);
  const e = parsed.data;
  const view: TraceEvent = {
    seq,
    at: e.at ?? null,
    type: e.type,
    kind: "generic",
    role: e.role ?? null,
    subtask_id: e.subtask_id ?? null,
    execution_id: null,
    attempt_id: e.attempt_id ?? null,
    summary: "",
    data: {},
    refs: {},
  };
  switch (e.type) {
    case "session_start":
      return {
        ...view,
        kind: "session",
        summary: "Execution session starting",
        data: {
          backend: e.config.backend ?? "persistent-kernel",
          image: e.config.image,
        },
      };
    case "ready":
      return {
        ...view,
        kind: "session",
        summary: "Execution environment ready",
        data: { kernel_epoch: e.kernel_epoch ?? null },
      };
    case "agent_budget":
      return {
        ...view,
        kind: "budget",
        summary: "Budget checked before model call",
        data: {
          remaining: e.remaining,
          max_output_tokens: e.max_output_tokens ?? null,
        },
      };
    case "model_request":
      return {
        ...view,
        kind: "model",
        summary: `Model request to ${e.requested_model ?? "model"}`,
        data: { input_estimate: e.input_estimate ?? null },
        refs: e.content_ref ? { content: refView(e.content_ref) } : {},
      };
    case "model_response":
      return {
        ...view,
        kind: "model",
        summary: `Model response from ${e.returned_model ?? "model"}`,
        data: {
          usage: e.usage
            ? {
                status: e.usage.status ?? null,
                input_tokens: e.usage.input_tokens ?? null,
                output_tokens: e.usage.output_tokens ?? null,
                total_tokens: e.usage.total_tokens ?? null,
              }
            : null,
          elapsed_ms: e.elapsed_ms ?? null,
        },
        refs: e.content_ref ? { content: refView(e.content_ref) } : {},
      };
    case "model_failure":
      return {
        ...view,
        kind: "model",
        summary: "Model call failed",
        data: scalars(record),
      };
    case "tool_validation":
      return {
        ...view,
        kind: "tool",
        execution_id: e.cell_id ?? e.execution_id ?? null,
        summary:
          e.valid !== undefined
            ? e.valid
              ? "Tool call accepted"
              : "Tool call rejected"
            : e.dispatched
              ? "Execution dispatch recorded"
              : "Execution feedback returned to the model",
        data: {
          valid: e.valid ?? null,
          dispatched: e.dispatched ?? false,
          request_id: e.request_id ?? null,
          diagnostic:
            typeof e.diagnostic === "string"
              ? clip(e.diagnostic, MAX_TEXT_CHARS).text
              : (e.diagnostic ?? null),
        },
        refs: e.content_ref ? { feedback: refView(e.content_ref) } : {},
      };
    case "subtask_delegated":
    case "subtask_returned":
      return {
        ...view,
        kind: "delegation",
        summary:
          e.type === "subtask_delegated"
            ? "Planner delegated a subtask"
            : "Executor returned the subtask",
        refs: e.content_ref ? { content: refView(e.content_ref) } : {},
      };
    case "dispatch": {
      const code = clip(e.request.code ?? "", MAX_CODE_CHARS);
      return {
        ...view,
        kind: "code",
        execution_id: e.request.cell_id ?? e.request.execution_id ?? null,
        summary: `Code dispatched (execution ${e.request.execution_seq ?? "?"})`,
        data: {
          request_id: e.request.request_id,
          execution_seq: e.request.execution_seq ?? null,
          kernel_epoch: e.request.kernel_epoch ?? null,
          code: code.text,
          code_truncated: code.truncated,
        },
      };
    }
    case "output": {
      const text =
        e.message.text === undefined
          ? null
          : clip(e.message.text, MAX_TEXT_CHARS);
      return {
        ...view,
        kind: "output",
        execution_id: e.message.cell_id ?? e.message.execution_id ?? null,
        summary: "Execution output",
        data: {
          request_id: e.message.request_id ?? null,
          output_type: e.message.output_type ?? null,
          name: e.message.name ?? null,
          text: text?.text ?? null,
          text_truncated: text?.truncated ?? false,
        },
        refs: e.output_ref ? { output: refView(e.output_ref) } : {},
      };
    }
    case "finish": {
      const preview = clip(e.result.preview ?? "", MAX_TEXT_CHARS);
      return {
        ...view,
        kind: "result",
        execution_id: e.result.cell_id ?? e.result.execution_id ?? null,
        summary: `Execution ${e.result.status}`,
        data: {
          request_id: e.result.request_id,
          status: e.result.status,
          execution_seq: e.result.execution_seq ?? null,
          elapsed_ms: e.result.elapsed_ms ?? null,
          preview: preview.text,
          preview_truncated:
            preview.truncated || (e.result.preview_truncated ?? false),
          partial_state_possible: e.result.partial_state_possible ?? false,
          error: e.result.error
            ? {
                ename: e.result.error.ename,
                evalue: clip(e.result.error.evalue, MAX_TEXT_CHARS).text,
              }
            : null,
        },
        refs: Object.fromEntries(
          (e.result.artifacts ?? []).map((a, i) => [
            `artifact_${i}`,
            refView(a),
          ]),
        ),
      };
    }
    case "artifact":
    case "artifact_saved":
      return {
        ...view,
        kind: "artifact",
        summary: `Artifact saved${e.artifact.source_path ? `: ${e.artifact.source_path}` : ""}`,
        refs: { artifact: refView(e.artifact) },
      };
    case "analysis_submitted":
    case "analysis_closing":
    case "report_saved":
      return {
        ...view,
        kind: "analysis",
        summary:
          e.type === "report_saved"
            ? "Report saved"
            : e.type === "analysis_closing"
              ? "Closing the analysis"
              : "Final analysis submitted",
        data: scalars(record),
      };
    case "agent_finish":
    case "run_finished":
      return {
        ...view,
        kind: "finish",
        summary:
          e.type === "agent_finish"
            ? `Agent finished: ${e.status}${e.reason ? ` (${e.reason})` : ""}`
            : `Run finished: ${e.status}`,
        data: { status: e.status, reason: e.reason ?? null },
      };
    default:
      return {
        ...view,
        kind: "diagnostic",
        summary: `Session ${e.type.replaceAll("_", " ")}`,
        data: scalars(record),
      };
  }
}

/** Where incremental reading of one events.jsonl stands. */
export interface EventCursor {
  /** Byte offset just after the last complete line consumed. */
  offset: number;
  /** Number of complete lines consumed so far. */
  seq: number;
}

const READ_CHUNK = 1024 * 1024;

/**
 * Reads the complete lines appended since `cursor` and returns those with seq > `after`.
 * A final line without its newline is still being written: it is left for the next call, the
 * same rule the record reader applies to a truncated last line.
 */
export async function readNewEvents(
  path: string,
  cursor: EventCursor,
  after = 0,
): Promise<{ events: TraceEvent[]; cursor: EventCursor }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { events: [], cursor };
    throw error;
  }
  const events: TraceEvent[] = [];
  let { offset, seq } = cursor;
  try {
    let carry = Buffer.alloc(0);
    let position = offset;
    for (;;) {
      const buffer = Buffer.alloc(READ_CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, position);
      if (bytesRead === 0) break;
      // `data` starts where the unconsumed carry-over began in the file.
      const dataStart = position - carry.length;
      position += bytesRead;
      const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      let start = 0;
      for (
        let newline = data.indexOf(0x0a, start);
        newline !== -1;
        newline = data.indexOf(0x0a, start)
      ) {
        const line = data.subarray(start, newline).toString("utf8");
        start = newline + 1;
        offset = dataStart + start;
        if (!line.trim()) continue;
        seq += 1;
        if (seq <= after) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          events.push(
            generic(seq, {}, "diagnostic", "Trace line is not valid JSON"),
          );
          continue;
        }
        events.push(normalizeEvent(seq, value));
      }
      carry = data.subarray(start);
    }
  } finally {
    await handle.close();
  }
  return { events, cursor: { offset, seq } };
}
