import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { emptyUsage, validateUsage } from "../evaluation/contracts";
import { methodManifestSchema } from "./catalog";
import { BRIDGE_LIMITS } from "./protocol";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const baselineRecordSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal("baseline-run"),
  run_id: z.string().min(1),
  unit_id: z.string().min(1),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  method: methodManifestSchema,
  config_hash: hash,
  environment: z.record(z.string(), z.unknown()),
  status: z.enum([
    "running",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "budget_exhausted",
  ]),
  reason: z.string(),
  usage: z.unknown().transform((v) => validateUsage(v)),
  cleanup_error: z.string().nullable(),
  record_error: z.boolean(),
  event_count: z.number().int().nonnegative(),
  event_bytes: z.number().int().nonnegative(),
});
export type BaselineRecord = z.infer<typeof baselineRecordSchema>;
export const baselineEventSchema = z.strictObject({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  sequence: z.number().int().positive(),
  at: z.iso.datetime(),
  type: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
});

/** 一个宿主串行写事件；记录失败不能被降格成方法成功。 */
export class BaselineRecorder {
  private tail: Promise<void> = Promise.resolve();
  private finished = false;
  private constructor(
    readonly directory: string,
    readonly record: BaselineRecord,
    readonly maxBytes: number,
  ) {}
  static async create(
    directory: string,
    identity: Pick<
      BaselineRecord,
      "run_id" | "unit_id" | "method" | "config_hash" | "environment"
    >,
    maxBytes = BRIDGE_LIMITS.log_bytes,
  ) {
    z.number().int().positive().parse(maxBytes);
    const record = baselineRecordSchema.parse({
      ...identity,
      schema_version: 1,
      kind: "baseline-run",
      started_at: new Date().toISOString(),
      ended_at: null,
      status: "running",
      reason: "started",
      cleanup_error: null,
      record_error: false,
      event_count: 0,
      event_bytes: 0,
      usage:
        identity.method.model === "none"
          ? emptyUsage("not_applicable")
          : { ...emptyUsage("not_applicable"), source: "measured" },
    });
    await mkdir(directory, { recursive: false });
    await writeFile(join(directory, "baseline.json"), JSON.stringify(record), {
      flag: "wx",
    });
    await writeFile(join(directory, "events.jsonl"), "", { flag: "wx" });
    return new BaselineRecorder(directory, record, maxBytes);
  }
  event(type: string, details: Record<string, unknown>): Promise<void> {
    if (this.finished)
      return Promise.reject(new Error("Baseline record already terminal"));
    const operation = this.tail.then(async () => {
      const event = baselineEventSchema.parse({
        schema_version: 1,
        run_id: this.record.run_id,
        sequence: this.record.event_count + 1,
        at: new Date().toISOString(),
        type,
        details,
      });
      const line = `${JSON.stringify(event)}\n`,
        bytes = Buffer.byteLength(line);
      if (this.record.event_bytes + bytes > this.maxBytes)
        throw new Error("Baseline event log limit exceeded");
      await appendFile(join(this.directory, "events.jsonl"), line);
      this.record.event_count++;
      this.record.event_bytes += bytes;
    });
    this.tail = operation.catch(() => {
      this.record.record_error = true;
    });
    return operation;
  }
  async finish(
    value: Pick<
      BaselineRecord,
      "status" | "reason" | "usage" | "cleanup_error"
    >,
  ) {
    if (this.finished || value.status === "running")
      throw new Error("Invalid baseline terminal transition");
    this.finished = true;
    await this.tail;
    Object.assign(this.record, value, { ended_at: new Date().toISOString() });
    if (this.record.record_error) {
      this.record.status = "failed";
      this.record.reason = "record_error";
    }
    baselineRecordSchema.parse(this.record);
    const temporary = join(this.directory, "baseline.final.json");
    await writeFile(temporary, JSON.stringify(this.record), { flag: "wx" });
    await rename(temporary, join(this.directory, "baseline.json"));
    return structuredClone(this.record);
  }
}
export async function readBaselineRecord(directory: string) {
  return baselineRecordSchema.parse(
    JSON.parse(await readFile(join(directory, "baseline.json"), "utf8")),
  );
}
