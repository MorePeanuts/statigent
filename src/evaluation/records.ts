import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { obj } from "../models/validation";
import { sha256, writeJson } from "../records/store";
import {
  type Budget,
  bounded,
  id,
  LIMITS,
  type Score,
  type Submission,
  validateScore,
  validateSubmission,
} from "./contracts";
import { describeFile, regular } from "./files";
import type { Plan, Unit } from "./plan";
import { command } from "./process";

export type UnitState =
  | "pending"
  | "running"
  | "not_run"
  | "unconfirmed"
  | Submission["status"];
export interface UnitRecord {
  unit: Unit;
  execution_status: UnitState;
  reason: string;
  started_at: string | null;
  ended_at: string | null;
  elapsed_ms: number;
  effective_budget: Budget | null;
  budget_status: "within" | "exceeded" | "unknown" | "reduced";
  submission_sha256: string | null;
  scoring_status: "pending" | "scored" | "failed";
  score: Score | null;
}
export interface Manifest {
  schema_version: 1;
  evaluation_id: string;
  created_at: string;
  completed_at: string | null;
  plan_sha256: string;
  status: "running" | "completed" | "incomplete";
  reason: string;
  environment: Record<string, unknown>;
  preflight: Record<string, unknown>;
}
async function optionalCommand(args: string[]): Promise<string> {
  try {
    return (await command(args)).stdout.trim();
  } catch {
    return "unknown";
  }
}
export async function environmentSnapshot(): Promise<Record<string, unknown>> {
  const [commit, dirty, uv, python, docker] = await Promise.all([
    optionalCommand(["git", "rev-parse", "HEAD"]),
    optionalCommand(["git", "status", "--porcelain"]),
    optionalCommand(["uv", "--version"]),
    optionalCommand([
      "uv",
      "run",
      "--offline",
      "--frozen",
      "python",
      "--version",
    ]),
    optionalCommand(["docker", "version", "--format", "{{.Server.Version}}"]),
  ]);
  const locks: Record<string, string> = {};
  for (const name of ["bun.lock", "uv.lock"]) {
    try {
      locks[name] = sha256(await readFile(name));
    } catch {
      locks[name] = "unknown";
    }
  }
  return {
    commit,
    dirty: dirty === "unknown" ? "unknown" : dirty.length > 0,
    bun: Bun.version,
    uv,
    python,
    docker,
    locks,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    cpu_count: cpus().length,
    memory_bytes: totalmem(),
  };
}
function sanitize(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string")
    return secrets.reduce((s, key) => s.replaceAll(key, "[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /secret|password|credential|api.?key|access.?token/i.test(key) &&
        !key.endsWith("_env")
          ? "[REDACTED]"
          : sanitize(v, secrets),
      ]),
    );
  return value;
}
export class EvaluationStore {
  private constructor(
    readonly directory: string,
    readonly manifest: Manifest,
    private readonly secrets: string[],
  ) {}
  static async create(
    root: string,
    plan: Plan,
    preflight: Record<string, unknown> = {},
    environment?: Record<string, unknown>,
  ): Promise<EvaluationStore> {
    const evaluationId = randomUUID();
    await mkdir(resolve(root), { recursive: true });
    const directory = join(resolve(root), evaluationId);
    await mkdir(directory, { mode: 0o700 });
    await mkdir(join(directory, "units"));
    await mkdir(join(directory, "scores"));
    await mkdir(join(directory, "native"));
    const manifest: Manifest = {
      schema_version: 1,
      evaluation_id: evaluationId,
      created_at: new Date().toISOString(),
      completed_at: null,
      plan_sha256: plan.sha256,
      status: "running",
      reason: "",
      environment: environment ?? (await environmentSnapshot()),
      preflight,
    };
    const secrets = plan.config.agents.flatMap((a) =>
      a.model
        ? [process.env[a.model.api_key_env]].filter((v): v is string =>
            Boolean(v),
          )
        : [],
    );
    const store = new EvaluationStore(directory, manifest, secrets);
    await store.json("plan.json", plan);
    await store.json("manifest.json", manifest);
    // All planned units exist before any adapter is invoked.
    for (const unit of plan.units) {
      await mkdir(join(directory, "units", unit.id));
      await store.unit({
        unit,
        execution_status: "pending",
        reason: "",
        started_at: null,
        ended_at: null,
        elapsed_ms: 0,
        effective_budget: null,
        budget_status: "within",
        submission_sha256: null,
        scoring_status: "pending",
        score: null,
      });
    }
    await store.event("plan_frozen", { plan_sha256: plan.sha256 });
    return store;
  }
  async json(path: string, value: unknown): Promise<void> {
    bounded(value, LIMITS.record);
    const safe = sanitize(value, this.secrets);
    await writeJson(join(this.directory, path), safe);
  }
  async event(type: string, data: unknown): Promise<void> {
    const path = join(this.directory, "events.jsonl"),
      line = `${JSON.stringify(sanitize({ at: new Date().toISOString(), type, data }, this.secrets))}\n`;
    bounded(data, LIMITS.request);
    const file = await open(path, "a", 0o600);
    try {
      if ((await file.stat()).size + Buffer.byteLength(line) > LIMITS.events)
        throw new Error("Event quota exceeded");
      await file.writeFile(line);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async unit(record: UnitRecord): Promise<void> {
    await this.json(`units/${id(record.unit.id)}/record.json`, record);
  }
  async freeze(submission: Submission): Promise<string> {
    const s = validateSubmission(
      sanitize(submission, this.secrets),
      submission.unit_id,
    );
    const directory = join(this.directory, "units", s.unit_id);
    const file = await open(join(directory, "submission.json"), "wx", 0o400);
    const bytes = Buffer.from(JSON.stringify(s));
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await mkdir(join(directory, "artifacts"));
    for (const a of s.artifacts)
      await writeFile(
        join(directory, "artifacts", a.name),
        Buffer.from(a.base64, "base64"),
        { flag: "wx", mode: 0o400 },
      );
    return sha256(bytes);
  }
  async finish(status: Manifest["status"], reason: string): Promise<void> {
    this.manifest.status = status;
    this.manifest.reason = reason;
    this.manifest.completed_at = new Date().toISOString();
    await this.event("batch_finished", { status, reason });
    await this.json("manifest.json", this.manifest);
  }
}
export async function readJson(root: string, path: string): Promise<unknown> {
  const file = await regular(root, path);
  if ((await stat(file)).size > LIMITS.record)
    throw new Error("Record quota exceeded");
  return JSON.parse(await readFile(file, "utf8"));
}
export async function readSubmission(
  directory: string,
  record: UnitRecord,
): Promise<Submission | null> {
  if (record.submission_sha256 === null) return null;
  const path = `units/${id(record.unit.id)}/submission.json`,
    description = await describeFile(directory, path);
  if (description.sha256 !== record.submission_sha256)
    throw new Error("Submission integrity mismatch");
  const s = validateSubmission(await readJson(directory, path), record.unit.id);
  for (const a of s.artifacts) {
    const f = await describeFile(
      directory,
      `units/${s.unit_id}/artifacts/${a.name}`,
    );
    if (f.sha256 !== sha256(Buffer.from(a.base64, "base64")))
      throw new Error("Artifact integrity mismatch");
  }
  return s;
}
export async function inspect(
  directory: string,
): Promise<{ manifest: Manifest; plan: Plan; records: UnitRecord[] }> {
  const m = obj(await readJson(directory, "manifest.json"));
  if (m.schema_version !== 1 || typeof m.plan_sha256 !== "string")
    throw new Error("Invalid manifest");
  const planValue = obj(await readJson(directory, "plan.json")),
    { sha256: checksum, ...body } = planValue;
  if (
    checksum !== m.plan_sha256 ||
    checksum !== sha256(Buffer.from(JSON.stringify(body)))
  )
    throw new Error("Plan integrity mismatch");
  // A plan was validated before freezing; validate all identities again before using disk paths.
  if (!Array.isArray(planValue.units)) throw new Error("Invalid plan units");
  const records: UnitRecord[] = [];
  for (const u of planValue.units) {
    const unit = obj(u);
    const r = obj(
      await readJson(directory, `units/${id(unit.id)}/record.json`),
    );
    if (
      JSON.stringify(r.unit) !== JSON.stringify(u) ||
      ![
        "pending",
        "running",
        "not_run",
        "unconfirmed",
        "completed",
        "failed",
        "timed_out",
        "cancelled",
        "budget_exhausted",
      ].includes(String(r.execution_status))
    )
      throw new Error("Invalid unit record");
    if (r.score !== null) validateScore(r.score, id(unit.id));
    const record = r as unknown as UnitRecord;
    await readSubmission(directory, record);
    records.push({
      ...record,
      execution_status:
        record.execution_status === "running"
          ? "unconfirmed"
          : record.execution_status,
    });
  }
  return {
    manifest: m as unknown as Manifest,
    plan: planValue as unknown as Plan,
    records,
  };
}
