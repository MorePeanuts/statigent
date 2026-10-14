import * as z from "zod";
import { safeRelativePath } from "../records/store";

export const BRIDGE_VERSION = 1;
export const BRIDGE_LIMITS = {
  request_bytes: 256 * 1024,
  response_bytes: 8 * 1024 ** 2,
  log_bytes: 16 * 1024 ** 2,
  stderr_bytes: 1024 ** 2,
};
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const text = z.string().max(BRIDGE_LIMITS.request_bytes);
export const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      return safeRelativePath(value) === value;
    } catch {
      return false;
    }
  }, "Expected relative task path");
const toolCallSchema = z.strictObject({
  id,
  type: z.literal("function"),
  function: z.strictObject({ name: id, arguments: text }),
});
export const messageSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("system"), content: text }),
  z.strictObject({ role: z.literal("user"), content: text }),
  z.strictObject({
    role: z.literal("assistant"),
    content: text.nullable(),
    reasoning_content: text.optional(),
    tool_calls: z.array(toolCallSchema).max(32).optional(),
  }),
  z.strictObject({ role: z.literal("tool"), content: text, tool_call_id: id }),
]);
export const submissionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), answer: text.min(1) }),
  z.strictObject({ kind: z.literal("report"), path: relativePathSchema }),
  z.strictObject({
    kind: z.literal("predictions"),
    bundle: relativePathSchema,
    entrypoint: relativePathSchema,
  }),
]);
const base = {
  protocol_version: z.literal(1),
  run_id: id,
  request_id: id,
  sequence: z.number().int().positive(),
};
export const requestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("model.request"),
    stage: id,
    messages: z.array(messageSchema).min(1).max(1000),
  }),
  z.strictObject({
    ...base,
    type: z.literal("execution.execute"),
    code: text.min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal("artifact.read"),
    path: relativePathSchema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("bundle.register"),
    bundle: relativePathSchema,
    entrypoint: relativePathSchema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("submission.finish"),
    submission: submissionSchema,
  }),
]);
export type BridgeRequest = z.infer<typeof requestSchema>;
export type BaselineSubmission = z.infer<typeof submissionSchema>;
export const responseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...base,
    type: z.literal("response"),
    status: z.literal("ok"),
    result: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    ...base,
    type: z.literal("response"),
    status: z.literal("error"),
    code: id,
    message: text,
    terminal: z.boolean(),
  }),
]);
export type BridgeResponse = z.infer<typeof responseSchema>;

/** 一次只接收一个请求；验证失败即关闭，不能继续尝试不同 ID 绕过顺序。 */
export class BridgeGate {
  private sequence = 0;
  private seen = new Set<string>();
  private pending: BridgeRequest | null = null;
  private closed = false;
  private bytes = 0;
  constructor(
    readonly runId: string,
    readonly limits = BRIDGE_LIMITS,
  ) {
    id.parse(runId);
  }

  private account(frame: string, limit: number) {
    const bytes = Buffer.byteLength(frame);
    this.bytes += bytes;
    if (bytes > limit || this.bytes > this.limits.log_bytes)
      throw new Error("Bridge message/log limit exceeded");
  }
  accept(frame: string): BridgeRequest {
    try {
      if (this.closed || this.pending)
        throw new Error("Bridge closed or request in flight");
      this.account(frame, this.limits.request_bytes);
      const request = requestSchema.parse(JSON.parse(frame));
      if (
        request.run_id !== this.runId ||
        this.seen.has(request.request_id) ||
        request.sequence !== this.sequence + 1
      )
        throw new Error("Bridge identity, duplicate or sequence violation");
      this.sequence = request.sequence;
      this.seen.add(request.request_id);
      this.pending = request;
      return request;
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  settle(value: unknown): string {
    try {
      if (this.closed || !this.pending)
        throw new Error("Late/unexpected bridge response");
      const response = responseSchema.parse(value);
      if (
        response.run_id !== this.runId ||
        response.request_id !== this.pending.request_id ||
        response.sequence !== this.pending.sequence
      )
        throw new Error("Bridge response identity mismatch");
      const frame = JSON.stringify(response);
      this.account(frame, this.limits.response_bytes);
      if (
        this.pending.type === "submission.finish" ||
        (response.status === "error" && response.terminal)
      )
        this.closed = true;
      this.pending = null;
      return `${frame}\n`;
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  close() {
    this.closed = true;
  }
}

/** 使用字节帧，避免拆分 UTF-8 字符或在无换行流上无限累积。 */
export class JsonlDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly maxBytes = BRIDGE_LIMITS.request_bytes) {}
  push(chunk: Uint8Array): string[] {
    const frames: string[] = [];
    for (let start = 0; start < chunk.length; ) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (this.pending.length + end - start > this.maxBytes)
        throw new Error("Bridge frame exceeds limit");
      this.pending = Buffer.concat([this.pending, chunk.subarray(start, end)]);
      if (newline < 0) break;
      frames.push(
        new TextDecoder("utf-8", { fatal: true }).decode(this.pending),
      );
      this.pending = Buffer.alloc(0);
      start = newline + 1;
    }
    return frames;
  }
  end() {
    if (this.pending.length) throw new Error("Incomplete JSONL frame at EOF");
  }
}
