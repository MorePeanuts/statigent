import {
  type MethodManifest,
  methodConfigIdentity,
  methodIdSchema,
  methodManifest,
} from "../baselines/catalog";
import {
  type ModelProfile,
  selectProfile,
  validateProfile,
} from "../models/config";
import { integer, keys, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";
import {
  type AgentAdapter,
  type AgentConfig,
  type BenchmarkAdapter,
  type Budget,
  contractVersion,
  envelope,
  id,
  literal,
  type PublicTask,
  validateBudget,
  validateCapabilities,
  validateTask,
} from "./contracts";

export class Registry {
  readonly benchmarks = new Map<string, BenchmarkAdapter>();
  readonly agents = new Map<string, AgentAdapter>();
  benchmark(adapter: BenchmarkAdapter): this {
    id(adapter.id);
    if (this.benchmarks.has(adapter.id)) throw new Error("Duplicate benchmark");
    this.benchmarks.set(adapter.id, adapter);
    return this;
  }
  agent(adapter: AgentAdapter): this {
    id(adapter.id);
    validateCapabilities(adapter.capabilities);
    if (this.agents.has(adapter.id)) throw new Error("Duplicate agent");
    this.agents.set(adapter.id, adapter);
    return this;
  }
  getBenchmark(name: string): BenchmarkAdapter {
    const a = this.benchmarks.get(name);
    if (!a) throw new Error(`Unknown benchmark: ${name}`);
    return a;
  }
  getAgent(name: string): AgentAdapter {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Unknown agent: ${name}`);
    return a;
  }
}
/** Judge budgets are separate from agent budgets and every field is mandatory. */
export interface JudgeBudget {
  timeout_ms: number;
  model_attempts: number;
  total_tokens: number;
}
export interface ScoringConfig {
  judges: Record<string, ModelProfile>;
  unit_budget: JudgeBudget;
  batch_budget: JudgeBudget;
  parse_retries: number;
  options: Record<string, unknown>;
}
export interface EvaluationConfig {
  schema_version: 2 | 3;
  cache_policy: "disabled";
  purpose: "development" | "formal";
  development_overlap: string;
  benchmark: {
    adapter: string;
    version: string;
    options: Record<string, unknown>;
    task_ids: string[];
  };
  agents: AgentConfig[];
  repetitions: number;
  seed: number;
  task_budget: Budget;
  batch_budget: Budget;
  scoring: ScoringConfig | null;
}
export function validateJudgeBudget(value: unknown): JudgeBudget {
  const b = validateBudget(value);
  if (b.model_attempts === null || b.total_tokens === null)
    throw new Error("Judge budgets require attempts and tokens");
  return {
    timeout_ms: b.timeout_ms,
    model_attempts: b.model_attempts,
    total_tokens: b.total_tokens,
  };
}
function validateScoring(
  value: unknown,
  benchmark: BenchmarkAdapter | undefined,
  profiles: unknown,
): ScoringConfig {
  const x = obj(value);
  keys(x, [
    "judges",
    "unit_budget",
    "batch_budget",
    "parse_retries",
    "options",
    "cross_agent_summary",
  ]);
  // TabArena-style rankings across methods need a different aggregation contract.
  if (x.cross_agent_summary !== undefined && x.cross_agent_summary !== false)
    throw new Error("Cross-agent summaries are not implemented");
  const judges: Record<string, ModelProfile> = {};
  for (const [role, v] of Object.entries(obj(x.judges)))
    judges[id(role)] =
      typeof v === "string" ? selectProfile(profiles, v) : validateProfile(v);
  const parse = integer(x.parse_retries ?? 2, "parse_retries", 0);
  if (parse > 10) throw new Error("parse_retries too large");
  return {
    judges,
    unit_budget: validateJudgeBudget(x.unit_budget),
    batch_budget: validateJudgeBudget(x.batch_budget),
    parse_retries: parse,
    options: benchmark?.scoringOptions
      ? benchmark.scoringOptions(x.options ?? {})
      : obj(x.options ?? {}),
  };
}
/** Checks role mapping and declared model capabilities before any agent runs. */
export function checkJudges(
  benchmark: BenchmarkAdapter,
  scoring: ScoringConfig | null,
): void {
  const roles = benchmark.judgeRoles?.(scoring?.options ?? {}) ?? [];
  if (!roles.length) {
    if (scoring && Object.keys(scoring.judges).length)
      throw new Error("Benchmark protocol declares no judge roles");
    return;
  }
  if (!scoring) throw new Error("Judged protocol requires scoring config");
  for (const role of roles) {
    const profile = scoring.judges[role.id];
    if (!profile) throw new Error(`Missing judge role mapping: ${role.id}`);
    if (role.needs.includes("vision") && !profile.capabilities.vision)
      throw new Error(`Judge role ${role.id} requires vision capability`);
  }
  for (const role of Object.keys(scoring.judges))
    if (!roles.some((r) => r.id === role))
      throw new Error(`Unknown judge role: ${role}`);
}
export function validateConfig(
  value: unknown,
  registry: Registry | null,
  profiles: unknown = [],
): EvaluationConfig {
  const version = contractVersion(value);
  const x = envelope(
    value,
    [
      "cache_policy",
      "purpose",
      "development_overlap",
      "benchmark",
      "agents",
      "repetitions",
      "seed",
      "task_budget",
      "batch_budget",
      ...(version !== 1 ? ["scoring"] : []),
    ],
    [1, 2, 3],
  );
  const b = obj(x.benchmark);
  keys(b, ["adapter", "version", "options", "task_ids"]);
  const benchmark = registry?.getBenchmark(id(b.adapter));
  const tasks = strings(b.task_ids, "task_ids").map(id);
  if (
    !tasks.length ||
    tasks.length > 10000 ||
    new Set(tasks).size !== tasks.length
  )
    throw new Error("Invalid/duplicate task selection");
  if (!Array.isArray(x.agents) || !x.agents.length)
    throw new Error("Agents required");
  const agents = x.agents.map((value): AgentConfig => {
    const a = obj(value);
    keys(a, [
      "id",
      "adapter",
      "options",
      "model_profile",
      "model",
      "require_seed",
    ]);
    if (
      typeof a.require_seed !== "boolean" ||
      (a.model_profile !== undefined && a.model !== undefined)
    )
      throw new Error("Invalid agent config");
    const adapter = registry?.getAgent(id(a.adapter));
    const model =
      a.model_profile !== undefined
        ? selectProfile(profiles, str(a.model_profile, "model_profile"))
        : a.model === null || a.model === undefined
          ? null
          : validateProfile(a.model);
    const cap = adapter ? validateCapabilities(adapter.capabilities) : null;
    if (
      cap &&
      ((cap.model === "configurable") !== (model !== null) ||
        (a.require_seed && cap.seed === "unsupported"))
    )
      throw new Error("Unsupported model/seed requirement");
    return {
      id: id(a.id),
      adapter: id(a.adapter),
      options: adapter ? adapter.options(a.options) : obj(a.options),
      model,
      require_seed: a.require_seed,
    };
  });
  if (new Set(agents.map((a) => a.id)).size !== agents.length)
    throw new Error("Duplicate agent config id");
  const task = validateBudget(x.task_budget),
    batch = validateBudget(x.batch_budget);
  for (const a of agents) {
    const cap = registry?.getAgent(a.adapter).capabilities;
    if (
      cap &&
      cap.model !== "none" &&
      (!cap.model_budget ||
        [
          task.model_attempts,
          task.total_tokens,
          batch.model_attempts,
          batch.total_tokens,
        ].some((v) => v === null))
    )
      throw new Error("Model budgets required and must be supported");
  }
  const scoring =
    x.scoring === undefined || x.scoring === null
      ? null
      : validateScoring(x.scoring, benchmark, profiles);
  if (benchmark) {
    checkJudges(benchmark, scoring);
    if (benchmark.requiresTrajectory?.(scoring?.options ?? {}))
      for (const a of agents)
        if (registry?.getAgent(a.adapter).capabilities.trajectory !== "unified")
          throw new Error(`Agent ${a.id} cannot deliver a unified trajectory`);
  }
  const repetitions = integer(x.repetitions, "repetitions");
  if (!Number.isSafeInteger(integer(x.seed, "seed", 0) + repetitions - 1))
    throw new Error("Seed range overflow");
  if (tasks.length * agents.length * repetitions > 10000)
    throw new Error("Plan too large");
  return {
    schema_version: version === 3 ? 3 : 2,
    cache_policy: literal(x.cache_policy ?? "disabled", ["disabled"]),
    purpose: literal(x.purpose, ["development", "formal"]),
    development_overlap: str(x.development_overlap, "development_overlap"),
    benchmark: {
      adapter: id(b.adapter),
      version: str(b.version, "version"),
      options: benchmark ? benchmark.options(b.options) : obj(b.options),
      task_ids: tasks,
    },
    agents,
    repetitions,
    seed: integer(x.seed, "seed", 0),
    task_budget: task,
    batch_budget: batch,
    scoring,
  };
}
export interface Unit {
  id: string;
  task_id: string;
  agent_id: string;
  repetition: number;
  seed: number;
}
export interface Plan {
  schema_version: 2 | 3;
  config: EvaluationConfig;
  tasks: PublicTask[];
  units: Unit[];
  source_root: string;
  provenance: Record<string, unknown>;
  adapters: Record<string, string>;
  baseline_methods?: Record<
    string,
    { source: MethodManifest; config_hash: string }
  >;
  /** Task id -> group key for grouped summaries (e.g. DSBench case). */
  groups: Record<string, string>;
  sha256: string;
}
export async function buildPlan(
  value: unknown,
  registry: Registry,
  profiles: unknown = [],
): Promise<Plan> {
  const config = validateConfig(value, registry, profiles);
  for (const agent of config.agents)
    await registry.getAgent(agent.adapter).preview?.(agent);
  const adapter = registry.getBenchmark(config.benchmark.adapter);
  const catalog = await adapter.catalog(config.benchmark.options);
  if (catalog.provenance.version !== config.benchmark.version)
    throw new Error("Benchmark version mismatch");
  const catalogTasks = catalog.tasks.map(validateTask);
  if (new Set(catalogTasks.map((t) => t.id)).size !== catalogTasks.length)
    throw new Error("Duplicate task identity");
  const tasks = config.benchmark.task_ids.map((name) => {
    const t = catalogTasks.find((t) => t.id === name);
    if (!t) throw new Error(`Unknown task: ${name}`);
    return t;
  });
  await adapter.preflight(config.benchmark.options, tasks);
  const groups: Record<string, string> = {};
  if (adapter.summaries?.length)
    for (const t of tasks) {
      const group = catalog.groups?.[t.id];
      if (!group) throw new Error(`Missing summary group: ${t.id}`);
      groups[t.id] = id(group);
    }
  const units: Unit[] = [];
  for (const t of tasks)
    for (const a of config.agents)
      for (let r = 0; r < config.repetitions; r++) {
        const capability = validateCapabilities(
          registry.getAgent(a.adapter).capabilities,
        );
        if (t.phase_inputs && capability.phase_isolation !== true)
          throw new Error(`Agent ${a.id} lacks phase isolation`);
        if (
          !registry
            .getAgent(a.adapter)
            .capabilities.outputs.includes(t.output.kind)
        )
          throw new Error(
            `Unsupported task output: ${t.output.kind} for agent ${a.id}`,
          );
        units.push({
          id: `unit-${String(units.length + 1).padStart(6, "0")}`,
          task_id: t.id,
          agent_id: a.id,
          repetition: r,
          seed: config.seed + r,
        });
      }
  const adapters: Record<string, string> = {
    [`benchmark:${adapter.id}`]: adapter.version,
  };
  for (const a of config.agents)
    adapters[`agent:${a.adapter}`] = registry.getAgent(a.adapter).version;
  const methods = Object.fromEntries(
    config.agents
      .filter((a) => methodIdSchema.safeParse(a.adapter).success)
      .map((a) => [
        a.id,
        {
          source: methodManifest(a.adapter),
          config_hash: methodConfigIdentity(a.options),
        },
      ]),
  );
  const body = {
    schema_version: 3 as const,
    config,
    tasks,
    units,
    source_root: catalog.source_root,
    provenance: catalog.provenance,
    adapters,
    ...(Object.keys(methods).length ? { baseline_methods: methods } : {}),
    groups,
  };
  return { ...body, sha256: sha256(Buffer.from(JSON.stringify(body))) };
}
