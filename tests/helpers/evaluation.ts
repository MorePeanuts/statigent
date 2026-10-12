import {
  type AgentAdapter,
  type BenchmarkAdapter,
  emptyUsage,
  type PublicTask,
  type Submission,
} from "../../src/evaluation/contracts";
import { Registry } from "../../src/evaluation/plan";
import { keys, obj } from "../../src/models/validation";
import { sha256 } from "../../src/records/store";
export const task: PublicTask = {
  schema_version: 1,
  id: "one",
  version: "v1",
  goal: "Sum the value column",
  constraints: [],
  inputs: [
    {
      path: "data.csv",
      sha256: sha256(Buffer.from("value\n1\n2\n")),
      bytes: 10,
    },
  ],
  output: { kind: "text", instructions: "Return @sum[value]" },
};
export function submission(unit = "unit-000001"): Submission {
  return {
    schema_version: 1,
    unit_id: unit,
    status: "completed",
    answer_text: "@sum[3]",
    reason: "done",
    artifacts: [],
    native_run: null,
    usage: emptyUsage("not_applicable"),
    cleanup_error: null,
    record_error: false,
  };
}
export function fixtureRegistry(
  root = "/tmp/fixture",
  run?: AgentAdapter["run"],
): Registry {
  const options = (value: unknown) => {
    const x = obj(value);
    keys(x, []);
    return x;
  };
  const benchmark: BenchmarkAdapter = {
    id: "synthetic",
    version: "1",
    protocol: "exact-v1",
    options,
    catalog: async () => ({
      tasks: [task, { ...task, id: "two" }],
      source_root: root,
      provenance: { version: "v1" },
    }),
    preflight: async () => {},
    score: async (_o, _t, s) => ({
      schema_version: 1,
      unit_id: s.unit_id,
      protocol: "exact-v1",
      status: "scored",
      metrics: [
        {
          name: "accuracy",
          value: Number(
            s.status === "completed" && s.answer_text === "@sum[3]",
          ),
          minimum: 0,
          maximum: 1,
          direction: "higher",
        },
      ],
      details: {},
      error: null,
    }),
  };
  const agent: AgentAdapter = {
    id: "fixture",
    version: "1",
    capabilities: {
      schema_version: 1,
      output: "text",
      model: "none",
      seed: "execution",
      isolation: "docker",
      model_budget: false,
      usage: "not_applicable",
    },
    options,
    preflight: async () => ({}),
    run: run ?? (async (i) => submission(i.unit_id)),
  };
  return new Registry().benchmark(benchmark).agent(agent);
}
export function config() {
  return {
    schema_version: 1,
    purpose: "development",
    development_overlap: "synthetic only",
    benchmark: {
      adapter: "synthetic",
      version: "v1",
      options: {},
      task_ids: ["one", "two"],
    },
    agents: [{ id: "a", adapter: "fixture", options: {}, require_seed: true }],
    repetitions: 1,
    seed: 42,
    task_budget: { timeout_ms: 1000, model_attempts: null, total_tokens: null },
    batch_budget: {
      timeout_ms: 10000,
      model_attempts: null,
      total_tokens: null,
    },
  };
}
