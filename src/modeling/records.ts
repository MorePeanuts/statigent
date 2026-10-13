import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { regular } from "../evaluation/files";
import { integer, obj, str } from "../models/validation";
import { sha256, writeJson } from "../records/store";
export class ModelingRecord {
  private failed = false;
  private bytes = 0;
  private sequence = 0;
  private constructor(
    readonly directory: string,
    readonly id: string,
    readonly maxBytes: number,
    readonly header: Record<string, unknown>,
  ) {}
  static async create(
    root: string,
    config: Record<string, unknown>,
    maxBytes: number,
    id = randomUUID(),
  ) {
    await mkdir(resolve(root), { recursive: true });
    const dir = resolve(root, id);
    await mkdir(dir);
    await mkdir(join(dir, "payloads"));
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"]),
      dirty = Bun.spawnSync(["git", "status", "--porcelain"]);
    const header = {
      schema_version: 1,
      kind: "modeling",
      run_id: id,
      started_at: new Date().toISOString(),
      config,
      code: {
        commit: commit.exitCode === 0 ? commit.stdout.toString().trim() : null,
        dirty: dirty.exitCode === 0 ? Boolean(dirty.stdout.length) : null,
      },
      environment: {
        os: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? null,
        logical_cpus: cpus().length,
        memory_bytes: totalmem(),
        bun: Bun.version,
      },
    };
    const r = new ModelingRecord(dir, id, maxBytes, header);
    await r.save({ status: "running" });
    return r;
  }
  async event(
    type: string,
    fields: Record<string, unknown> = {},
    content?: unknown,
  ) {
    if (this.failed) throw new Error("record_failure");
    try {
      const event: Record<string, unknown> = {
        ...fields,
        type,
        run_id: this.id,
        at: new Date().toISOString(),
        sequence: ++this.sequence,
      };
      if (content !== undefined) {
        const bytes = Buffer.from(JSON.stringify(content));
        this.bytes += bytes.length;
        if (this.bytes > this.maxBytes) throw new Error("trace_size_limit");
        const path = `payloads/${this.sequence}.json`;
        await writeFile(join(this.directory, path), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        event.content_ref = {
          path,
          sha256: sha256(bytes),
          bytes: bytes.length,
        };
      }
      const line = `${JSON.stringify(event)}\n`;
      this.bytes += Buffer.byteLength(line);
      if (this.bytes > this.maxBytes) throw new Error("trace_size_limit");
      const handle = await open(join(this.directory, "events.jsonl"), "a");
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (e) {
      this.failed = true;
      throw new Error(`record_failure:${String(e)}`);
    }
  }
  async save(fields: Record<string, unknown>) {
    if (this.failed) throw new Error("record_failure");
    try {
      await writeJson(join(this.directory, "modeling.json"), {
        ...this.header,
        ...fields,
      });
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
}
export async function inspectModeling(directory: string) {
  const path = await regular(directory, "modeling.json");
  if ((await stat(path)).size > 32 * 1024 ** 2)
    throw new Error("Manifest too large");
  const manifest = obj(JSON.parse(await readFile(path, "utf8")));
  if (manifest.schema_version !== 1 || manifest.kind !== "modeling")
    throw new Error("Unsupported modeling record");
  str(manifest.run_id, "run ID");
  str(manifest.status, "status");
  const eventPath = await regular(directory, "events.jsonl");
  if ((await stat(eventPath)).size > 64 * 1024 ** 2)
    throw new Error("Events too large");
  const events = (await readFile(eventPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => obj(JSON.parse(line)));
  for (const [i, e] of events.entries()) {
    if (
      e.run_id !== manifest.run_id ||
      integer(e.sequence, "sequence") !== i + 1
    )
      throw new Error("Event identity mismatch");
    str(e.type, "event type");
    if (e.content_ref) {
      const ref = obj(e.content_ref),
        p = str(ref.path, "payload path");
      if (!/^payloads\/\d+\.json$/.test(p))
        throw new Error("Invalid payload path");
      const data = await readFile(await regular(directory, p));
      if (data.length !== ref.bytes || sha256(data) !== ref.sha256)
        throw new Error("Payload integrity mismatch");
    }
  }
  const completed = new Set(
    events.filter((e) => e.type === "child_result").map((e) => e.child_id),
  );
  return {
    manifest,
    events,
    unconfirmed_children: events.filter(
      (e) => e.type === "child_intent" && !completed.has(e.child_id),
    ),
  };
}
