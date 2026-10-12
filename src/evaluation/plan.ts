import { selectProfile, validateProfile } from "../models/config";
import { integer, keys, obj, str, strings } from "../models/validation";
import { sha256 } from "../records/store";
import {
  type AgentAdapter,
  type AgentConfig,
  type BenchmarkAdapter,
  type Budget,
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
export interface EvaluationConfig {
  schema_version: 1;
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
}
export function validateConfig(
  value: unknown,
  registry: Registry,
  profiles: unknown = [],
): EvaluationConfig {
  const x = envelope(value, [
    "purpose",
    "development_overlap",
    "benchmark",
    "agents",
    "repetitions",
    "seed",
    "task_budget",
    "batch_budget",
  ]);
  const b = obj(x.benchmark);
  keys(b, ["adapter", "version", "options", "task_ids"]);
  const benchmark = registry.getBenchmark(id(b.adapter));
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
    const adapter = registry.getAgent(id(a.adapter));
    const model =
      a.model_profile !== undefined
        ? selectProfile(profiles, str(a.model_profile, "model_profile"))
        : a.model === null || a.model === undefined
          ? null
          : validateProfile(a.model);
    const cap = validateCapabilities(adapter.capabilities);
    if (
      (cap.model === "configurable") !== (model !== null) ||
      (a.require_seed && cap.seed === "unsupported")
    )
      throw new Error("Unsupported model/seed requirement");
    return {
      id: id(a.id),
      adapter: adapter.id,
      options: adapter.options(a.options),
      model,
      require_seed: a.require_seed,
    };
  });
  if (new Set(agents.map((a) => a.id)).size !== agents.length)
    throw new Error("Duplicate agent config id");
  const task = validateBudget(x.task_budget),
    batch = validateBudget(x.batch_budget);
  for (const a of agents) {
    const cap = registry.getAgent(a.adapter).capabilities;
    if (
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
  const repetitions = integer(x.repetitions, "repetitions");
  if (tasks.length * agents.length * repetitions > 10000)
    throw new Error("Plan too large");
  return {
    schema_version: 1,
    purpose: literal(x.purpose, ["development", "formal"]),
    development_overlap: str(x.development_overlap, "development_overlap"),
    benchmark: {
      adapter: benchmark.id,
      version: str(b.version, "version"),
      options: benchmark.options(b.options),
      task_ids: tasks,
    },
    agents,
    repetitions,
    seed: integer(x.seed, "seed", 0),
    task_budget: task,
    batch_budget: batch,
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
  schema_version: 1;
  config: EvaluationConfig;
  tasks: PublicTask[];
  units: Unit[];
  source_root: string;
  provenance: Record<string, unknown>;
  adapters: Record<string, string>;
  sha256: string;
}
export async function buildPlan(
  value: unknown,
  registry: Registry,
  profiles: unknown = [],
): Promise<Plan> {
  const config = validateConfig(value, registry, profiles);
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
  const units: Unit[] = [];
  for (const t of tasks)
    for (const a of config.agents)
      for (let r = 0; r < config.repetitions; r++) {
        if (registry.getAgent(a.adapter).capabilities.output !== t.output.kind)
          throw new Error("Unsupported task output");
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
  const body = {
    schema_version: 1 as const,
    config,
    tasks,
    units,
    source_root: catalog.source_root,
    provenance: catalog.provenance,
    adapters,
  };
  return { ...body, sha256: sha256(Buffer.from(JSON.stringify(body))) };
}
