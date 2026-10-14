import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStrictOptions } from "../cli-options";
import { MODELING_METHODS } from "../modeling/config";
import { sha256 } from "../records/store";
import { parseModelingCatalog } from "./benchmarks/modeling/catalog";

// 在任何本轮真实成绩可见前，按提案中的规模与输出形式固定；不提供按分数替换任务的分支。
export const MODELING_DEVELOPMENT = [
  {
    benchmark: "dsbench-modeling",
    task_id: "playground-series-s3e9",
    coverage: "regression",
    exposure: "已用于真实协同/no_eda 开发；本轮继续作为已暴露开发题",
  },
  {
    benchmark: "dsbench-modeling",
    task_id: "titanic",
    coverage: "binary",
    exposure: "已用于数据准备和软件测试",
  },
  {
    benchmark: "dsbench-modeling",
    task_id: "playground-series-s4e2",
    coverage: "multiclass",
    exposure: "公开元数据预选",
  },
  {
    benchmark: "dsbench-modeling",
    task_id: "playground-series-s3e5",
    coverage: "ordinal",
    exposure: "已用于数据准备和指标测试",
  },
  {
    benchmark: "dsbench-modeling",
    task_id: "playground-series-s3e13",
    coverage: "top3",
    exposure: "已用于数据准备和指标测试",
  },
  {
    benchmark: "dsbench-modeling",
    task_id: "playground-series-s3e18",
    coverage: "two-target",
    exposure: "已用于数据准备和指标测试",
  },
  {
    benchmark: "dsbench-modeling",
    task_id: "playground-series-s4e3",
    coverage: "seven-target",
    exposure: "已用于数据准备和指标测试",
  },
  {
    benchmark: "tabarena-lite",
    task_id: "363612",
    coverage: "regression",
    exposure: "已用于 airfoil 数据准备",
  },
  {
    benchmark: "tabarena-lite",
    task_id: "363621",
    coverage: "binary",
    exposure: "已用于 blood 数据准备",
  },
  {
    benchmark: "tabarena-lite",
    task_id: "363685",
    coverage: "multiclass",
    exposure: "已用于 maternal 数据准备",
  },
] as const;

export async function writeModelingDevelopment() {
  const bytes = await Bun.file(
    "benchmarks/metadata/modeling-task-catalog.json",
  ).bytes();
  const catalog = parseModelingCatalog(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  const image =
    "sha256:74e2d6be21f7f304fe7a0fd14a8e102b35de2de10a79aef12bcec6c778273de3";
  const selected = MODELING_DEVELOPMENT.map((entry) => {
    const task = catalog.tasks.find(
      (t) => t.benchmark === entry.benchmark && t.task_id === entry.task_id,
    );
    if (!task)
      throw new Error("Development selection missing from frozen catalog");
    return {
      ...entry,
      source_revision: task.source_revision,
      issues: task.issues,
      research: task.research,
    };
  });
  const common = {
    schema_version: 3,
    cache_policy: "disabled",
    purpose: "development",
    development_overlap:
      "固定公开类型/规模覆盖；全部属于开发暴露，s3e9 有既有真实运行；不作为未见正式任务。DSBench 与其原始竞赛/同源数据的重叠及 TabArena 来源关系需在正式集合前审核。",
    repetitions: 1,
    seed: 17,
  };
  const taskBudget = {
    timeout_ms: 900000,
    model_attempts: 30,
    total_tokens: 300000,
  };
  const options = {
    image,
    confirmation: { mode: "terminal_repeated_holdout" },
    resource_version: "modeling-development-v1",
    budget: {
      training_attempts: 12,
      final_training_attempts: 1,
      final_reserve_ms: 450000,
      fit_timeout_ms: 60000,
      predict_timeout_ms: 30000,
      eda_calls: 2,
      eda_model_attempts: 20,
      eda_tokens: 200000,
      eda_timeout_ms: 300000,
    },
    limits: { memory_bytes: 2 * 1024 ** 3, cpus: 1 },
  };
  const configs: { path: string; value: unknown }[] = [];
  for (const benchmark of ["dsbench-modeling", "tabarena-lite"] as const) {
    const tasks = selected.filter((t) => t.benchmark === benchmark);
    const base = {
      ...common,
      benchmark: {
        adapter: benchmark,
        version: tasks[0]?.source_revision,
        options: {
          prepared_root: "runs/modeling-candidate-preparation-v1/datasets",
          datasets: Object.fromEntries(
            tasks.map((t) => [t.task_id, `${benchmark}/${t.task_id}`]),
          ),
          data_root: "benchmarks",
        },
        task_ids: tasks.map((t) => t.task_id),
      },
    };
    for (const method of MODELING_METHODS)
      configs.push({
        path: `configs/evaluations/modeling-development/${benchmark}-${method}.json`,
        value: {
          ...base,
          agents: [
            {
              id: method,
              adapter: "statigent-modeling",
              options: { ...options, method },
              model_profile: "deepseek-flash",
              require_seed: true,
            },
          ],
          task_budget: taskBudget,
          batch_budget: Object.fromEntries(
            Object.entries(taskBudget).map(([k, v]) => [k, v * tasks.length]),
          ),
        },
      });
    configs.push({
      path: `configs/evaluations/modeling-development/${benchmark}-deterministic.json`,
      value: {
        ...base,
        agents: [
          {
            id: "deterministic",
            adapter: "deterministic-modeling",
            options: {
              ...options,
              method: "no_eda",
              confirmation: { mode: "none" },
            },
            require_seed: true,
          },
        ],
        task_budget: {
          ...taskBudget,
          model_attempts: null,
          total_tokens: null,
        },
        batch_budget: {
          timeout_ms: taskBudget.timeout_ms * tasks.length,
          model_attempts: null,
          total_tokens: null,
        },
      },
    });
  }
  await mkdir("configs/evaluations/modeling-development", { recursive: true });
  for (const config of configs)
    await writeFile(config.path, `${JSON.stringify(config.value, null, 2)}\n`, {
      flag: "wx",
    });
  const manifest = {
    schema_version: 1,
    selection: "proposal-public-type-size-coverage-v1",
    catalog_sha256: sha256(Buffer.from(bytes)),
    selected,
    image,
    repeats: 1,
    seed: 17,
    methods: MODELING_METHODS,
    prepared_root: "runs/modeling-candidate-preparation-v1/datasets",
    configs: configs.map((c) => c.path),
    live_status: "not_run",
    formal_status: "not_frozen",
    rule: "失败不换题、不自动重跑；研究资格和数据同源关系另审。",
  };
  await writeFile(
    join("benchmarks/metadata", "modeling-development.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return manifest;
}
if (import.meta.main) {
  const flags = parseStrictOptions(
    process.argv.slice(2),
    [],
    "Use explicit --write to freeze new development configs",
    ["--write"],
  );
  if (flags["--write"] !== "true")
    throw new Error("Use explicit --write to freeze new development configs");
  console.log(JSON.stringify(await writeModelingDevelopment(), null, 2));
}
