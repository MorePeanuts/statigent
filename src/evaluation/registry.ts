import { containerCommandAdapter } from "./agents/container-command";
import { modelingAdapter } from "./agents/modeling";
import { statigentAdapter } from "./agents/statigent";
import { createDacomp } from "./benchmarks/dacomp";
import { createDsbenchAnalysis } from "./benchmarks/dsbench";
import { createInfiAgent } from "./benchmarks/infiagent";
import { createModelingBenchmark } from "./benchmarks/modeling/adapter";
import { syntheticBenchmark } from "./benchmarks/synthetic";
import { Registry } from "./plan";
export function defaultRegistry(): Registry {
  return new Registry()
    .benchmark(createInfiAgent())
    .benchmark(createDsbenchAnalysis())
    .benchmark(createDacomp())
    .benchmark(syntheticBenchmark)
    .benchmark(createModelingBenchmark("dsbench-modeling"))
    .benchmark(createModelingBenchmark("tabarena-lite"))
    .agent(statigentAdapter())
    .agent(modelingAdapter())
    .agent(modelingAdapter({ deterministic: true }))
    .agent(containerCommandAdapter())
    .agent(baselineAdapter("react"))
    .agent(baselineAdapter("autogen"))
    .agent(baselineAdapter("datawiseagent"))
    .agent(baselineAdapter("autogluon"));
}

import { baselineAdapter } from "../baselines/adapter";
