import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { integer, keys, obj, str } from "../models/validation";
import { sha256, writeJson } from "../records/store";
import {
  type Budget,
  bounded,
  contractVersion,
  envelope,
  hash,
  id,
  LIMITS,
  literal,
  type Score,
  type Submission,
  validateBudget,
  validateScore,
  validateSubmission,
  validateTask,
} from "./contracts";
import { verifyDeliverables } from "./deliverables";
import { describeFile, regular } from "./files";
import { type Plan, type Unit, validateConfig } from "./plan";
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
  scoring_elapsed_ms?: number;
  effective_budget: Budget | null;
  budget_status: "within" | "exceeded" | "unknown" | "reduced";
  submission_sha256: string | null;
  /** `not_scored`: judging never started for this unit, e.g. the judge budget ran out first. */
  scoring_status: "pending" | "scored" | "failed" | "not_scored";
  scoring_reason?: string;
  score: Score | null;
}
export interface Manifest {
  schema_version: 2;
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
export async function codeSnapshot(): Promise<Record<string, unknown>> {
  const [commit, status] = await Promise.all([
    optionalCommand(["git", "rev-parse", "HEAD"]),
    optionalCommand(["git", "status", "--porcelain"]),
  ]);
  return {
    commit,
    dirty: status === "unknown" ? "unknown" : status.length > 0,
    bun: Bun.version,
  };
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
      schema_version: 2,
      evaluation_id: evaluationId,
      created_at: new Date().toISOString(),
      completed_at: null,
      plan_sha256: plan.sha256,
      status: "running",
      reason: "",
      environment: environment ?? (await environmentSnapshot()),
      preflight,
    };
    const profiles = [
      ...plan.config.agents.flatMap((a) => (a.model ? [a.model] : [])),
      ...Object.values(plan.config.scoring?.judges ?? {}),
    ];
    const secrets = profiles
      .map((p) => process.env[p.api_key_env])
      .filter((v): v is string => Boolean(v));
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
  /** Writes the submission once; its deliverables were already frozen in `units/<id>/deliverables`. */
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
export interface StoredSubmission {
  submission: Submission;
  /** Absolute directory holding the frozen deliverables (`artifacts/` for v1 records). */
  deliverables_root: string;
}
/** Reads a frozen submission and re-verifies its deliverables; v1 inline artifacts stay readable. */
export async function readSubmission(
  directory: string,
  record: UnitRecord,
): Promise<StoredSubmission | null> {
  if (record.submission_sha256 === null) return null;
  const path = `units/${id(record.unit.id)}/submission.json`,
    description = await describeFile(directory, path);
  if (description.sha256 !== record.submission_sha256)
    throw new Error("Submission integrity mismatch");
  const raw = await readJson(directory, path);
  const s = validateSubmission(raw, record.unit.id);
  if (contractVersion(raw) === 1) {
    for (const d of s.deliverables) {
      const f = await describeFile(
        directory,
        `units/${s.unit_id}/artifacts/${d.path}`,
      );
      if (f.sha256 !== d.sha256) throw new Error("Artifact integrity mismatch");
    }
    return {
      submission: s,
      deliverables_root: join(
        resolve(directory),
        "units",
        s.unit_id,
        "artifacts",
      ),
    };
  }
  const root = join(resolve(directory), "units", s.unit_id, "deliverables");
  await verifyDeliverables(root, s.deliverables);
  return { submission: s, deliverables_root: root };
}
export async function inspect(
  directory: string,
): Promise<{ manifest: Manifest; plan: Plan; records: UnitRecord[] }> {
  const m = envelope(
    await readJson(directory, "manifest.json"),
    [
      "evaluation_id",
      "created_at",
      "completed_at",
      "plan_sha256",
      "status",
      "reason",
      "environment",
      "preflight",
    ],
    [1, 2],
  );
  if (typeof m.plan_sha256 !== "string") throw new Error("Invalid manifest");
  const rawPlan = await readJson(directory, "plan.json");
  const planVersion = contractVersion(rawPlan);
  const planValue = envelope(
      rawPlan,
      [
        "config",
        "tasks",
        "units",
        "source_root",
        "provenance",
        "adapters",
        ...(planVersion === 2 ? ["groups"] : []),
        "sha256",
      ],
      [1, 2],
    ),
    { sha256: checksum, ...body } = planValue;
  if (
    checksum !== m.plan_sha256 ||
    checksum !== sha256(Buffer.from(JSON.stringify(body)))
  )
    throw new Error("Plan integrity mismatch");
  // A plan was validated before freezing; validate all identities again before using disk paths.
  if (!Array.isArray(planValue.units) || !Array.isArray(planValue.tasks))
    throw new Error("Invalid plan units/tasks");
  const config = validateConfig(planValue.config, null);
  const tasks = planValue.tasks.map(validateTask);
  const units: Unit[] = planValue.units.map((value) => {
    const u = obj(value);
    keys(u, ["id", "task_id", "agent_id", "repetition", "seed"]);
    return {
      id: id(u.id),
      task_id: id(u.task_id),
      agent_id: id(u.agent_id),
      repetition: integer(u.repetition, "repetition", 0),
      seed: integer(u.seed, "seed", 0),
    };
  });
  if (
    new Set(units.map((u) => u.id)).size !== units.length ||
    units.length !==
      config.benchmark.task_ids.length *
        config.agents.length *
        config.repetitions ||
    units.some(
      (u) =>
        !tasks.some((t) => t.id === u.task_id) ||
        !config.agents.some((a) => a.id === u.agent_id) ||
        u.repetition >= config.repetitions,
    )
  )
    throw new Error("Invalid plan references");
  const adapters = Object.fromEntries(
    Object.entries(obj(planValue.adapters)).map(([k, v]) => [
      k,
      str(v, "adapter version"),
    ]),
  );
  const groups = Object.fromEntries(
    Object.entries(obj(planValue.groups ?? {})).map(([k, v]) => [id(k), id(v)]),
  );
  const plan: Plan = {
    schema_version: 2,
    config,
    tasks,
    units,
    source_root: str(planValue.source_root, "source_root"),
    provenance: obj(planValue.provenance),
    adapters,
    groups,
    sha256: hash(checksum),
  };
  const manifest: Manifest = {
    schema_version: 2,
    evaluation_id: id(m.evaluation_id),
    created_at: str(m.created_at, "created_at"),
    completed_at:
      m.completed_at === null ? null : str(m.completed_at, "completed_at"),
    plan_sha256: hash(m.plan_sha256),
    status: literal(m.status, ["running", "completed", "incomplete"]),
    reason: typeof m.reason === "string" ? m.reason : str(m.reason, "reason"),
    environment: obj(m.environment),
    preflight: obj(m.preflight),
  };
  const records: UnitRecord[] = [];
  for (const u of units) {
    const unit = obj(u);
    const r = obj(
      await readJson(directory, `units/${id(unit.id)}/record.json`),
    );
    keys(r, [
      "unit",
      "execution_status",
      "reason",
      "started_at",
      "ended_at",
      "elapsed_ms",
      "scoring_elapsed_ms",
      "effective_budget",
      "budget_status",
      "submission_sha256",
      "scoring_status",
      "scoring_reason",
      "score",
    ]);
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
    if (
      typeof r.reason !== "string" ||
      typeof r.elapsed_ms !== "number" ||
      !Number.isFinite(r.elapsed_ms) ||
      r.elapsed_ms < 0
    )
      throw new Error("Invalid record reason/timing");
    if (
      r.scoring_elapsed_ms !== undefined &&
      (typeof r.scoring_elapsed_ms !== "number" ||
        !Number.isFinite(r.scoring_elapsed_ms) ||
        r.scoring_elapsed_ms < 0)
    )
      throw new Error("Invalid scoring timing");
    const record: UnitRecord = {
      ...(typeof r.scoring_elapsed_ms === "number"
        ? { scoring_elapsed_ms: r.scoring_elapsed_ms }
        : {}),
      unit: u,
      execution_status: literal(r.execution_status, [
        "pending",
        "running",
        "not_run",
        "unconfirmed",
        "completed",
        "failed",
        "timed_out",
        "cancelled",
        "budget_exhausted",
      ]),
      reason: r.reason,
      started_at:
        r.started_at === null ? null : str(r.started_at, "started_at"),
      ended_at: r.ended_at === null ? null : str(r.ended_at, "ended_at"),
      elapsed_ms: r.elapsed_ms,
      effective_budget:
        r.effective_budget === null ? null : validateBudget(r.effective_budget),
      budget_status: literal(r.budget_status, [
        "within",
        "exceeded",
        "unknown",
        "reduced",
      ]),
      submission_sha256:
        r.submission_sha256 === null ? null : hash(r.submission_sha256),
      scoring_status: literal(r.scoring_status, [
        "pending",
        "scored",
        "failed",
        "not_scored",
      ]),
      ...(r.scoring_reason === undefined
        ? {}
        : { scoring_reason: str(r.scoring_reason, "scoring_reason") }),
      score: r.score === null ? null : validateScore(r.score, u.id),
    };
    if (
      record.score
        ? record.scoring_status !== record.score.status
        : !["pending", "not_scored"].includes(record.scoring_status)
    )
      throw new Error("Inconsistent scoring status");
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
    manifest,
    plan,
    records,
  };
}
