import { containerCommandAdapter } from "./agents/container-command";
import { statigentAdapter } from "./agents/statigent";
import { createInfiAgent } from "./benchmarks/infiagent";
import { syntheticBenchmark } from "./benchmarks/synthetic";
import { Registry } from "./plan";
export function defaultRegistry(): Registry {
  return new Registry()
    .benchmark(createInfiAgent())
    .benchmark(syntheticBenchmark)
    .agent(statigentAdapter())
    .agent(containerCommandAdapter());
}
