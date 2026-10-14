import * as z from "zod";
import { canonicalJson } from "../modeling/protocol-v2";
import { sha256 } from "../records/store";

export const methodIdSchema = z.enum([
  "react",
  "autogen",
  "datawiseagent",
  "autogluon",
]);
export type MethodId = z.infer<typeof methodIdSchema>;
const nonempty = z.string().trim().min(1);
const revision = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local"), version: nonempty }),
  z.strictObject({
    kind: z.literal("package"),
    name: nonempty,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }),
  z.strictObject({
    kind: z.literal("git"),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
  }),
]);

/** 来源声明与就绪状态分离；清单存在不表示依赖、适配器或实验已通过。 */
export const methodManifestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    method: methodIdSchema,
    version: nonempty,
    implementation: z.enum(["local-method", "upstream-adapted"]),
    paper: z.url(),
    repository: z.url().nullable(),
    upstream_license: nonempty.nullable(),
    revision,
    outputs: z.array(z.enum(["text", "report", "predictions"])).min(1),
    model: z.enum(["configurable", "none"]),
    backend: z.enum(["persistent-kernel", "fresh-script", "automl"]),
    prompts: z.array(nonempty),
    deviations: z.array(nonempty),
  })
  .superRefine((x, ctx) => {
    const automl = x.method === "autogluon";
    if (
      new Set(x.outputs).size !== x.outputs.length ||
      (x.method === "react") !== (x.implementation === "local-method") ||
      (x.method === "react") !== (x.revision.kind === "local") ||
      (x.method === "datawiseagent") !== (x.revision.kind === "git") ||
      (x.model === "none") !== automl ||
      (x.backend === "automl") !== automl ||
      (automl && (x.outputs.length !== 1 || x.outputs[0] !== "predictions"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Inconsistent method identity/capabilities",
      });
  });
export type MethodManifest = z.infer<typeof methodManifestSchema>;

const sharedDeviations = [
  "统一宿主模型配置、父预算与无网络 CPU 执行；不使用上游独立密钥、重试或缓存。",
  "建模先冻结完整模型及预测入口，再在独立容器发布测试特征；不使用测试评分反馈。",
];
const manifests: Record<MethodId, MethodManifest> = {
  react: methodManifestSchema.parse({
    schema_version: 1,
    method: "react",
    version: "react-tabular-v1",
    implementation: "local-method",
    paper: "https://arxiv.org/abs/2210.03629",
    repository: null,
    upstream_license: null,
    revision: { kind: "local", version: "react-tabular-v1" },
    outputs: ["text", "report", "predictions"],
    model: "configurable",
    backend: "persistent-kernel",
    prompts: ["react-tabular-v1"],
    deviations: [
      ...sharedDeviations,
      "本地表格任务适配；单角色保留历史，无 findings/evidence_refs 完成门槛。",
    ],
  }),
  autogen: methodManifestSchema.parse({
    schema_version: 1,
    method: "autogen",
    version: "autogen-tabular-v1",
    implementation: "upstream-adapted",
    paper: "https://arxiv.org/abs/2308.08155",
    repository: "https://github.com/microsoft/autogen",
    upstream_license: "MIT",
    revision: { kind: "package", name: "pyautogen", version: "0.2.35" },
    outputs: ["text", "report", "predictions"],
    model: "configurable",
    backend: "fresh-script",
    prompts: ["AssistantAgent.DEFAULT_SYSTEM_MESSAGE", "baseline-output-v1"],
    deviations: [
      ...sharedDeviations,
      "AssistantAgent + UserProxyAgent；执行代理无 LLM、无人类输入；任务内文件可复用。",
      "非 DSBench 原配置逐项复现；完成标记与显式交付同时校验。",
    ],
  }),
  datawiseagent: methodManifestSchema.parse({
    schema_version: 1,
    method: "datawiseagent",
    version: "datawiseagent-tabular-v1",
    implementation: "upstream-adapted",
    paper: "https://arxiv.org/abs/2503.07044",
    repository: "https://github.com/zimingyou01/DatawiseAgent",
    upstream_license: "Apache-2.0",
    revision: {
      kind: "git",
      commit: "64f3164869fa2558e7385d0e33a241aee2baf37f",
    },
    outputs: ["text", "report", "predictions"],
    model: "configurable",
    backend: "persistent-kernel",
    prompts: [
      "datawiseagent/prompts/datawise.py",
      "configs/default_config.yaml",
      "configs/datamodeling.yaml",
      "baseline-output-v1",
    ],
    deviations: [
      ...sharedDeviations,
      "保留官方 FST；边界子类替换模型及执行器；禁用自动内核恢复和未知执行重放。",
      "禁用上游 GPU/联网安装；显式交付，不额外调用模型总结。",
    ],
  }),
  autogluon: methodManifestSchema.parse({
    schema_version: 1,
    method: "autogluon",
    version: "autogluon-cpu-v1",
    implementation: "upstream-adapted",
    paper: "https://arxiv.org/abs/2003.06505",
    repository: "https://github.com/autogluon/autogluon",
    upstream_license: "Apache-2.0",
    revision: { kind: "package", name: "autogluon.tabular", version: "1.4.0" },
    outputs: ["predictions"],
    model: "none",
    backend: "automl",
    prompts: [],
    deviations: [
      "CPU best_quality；显式 GBM/CAT/XGB/RF/XT/NN_TORCH，不下载预训练权重。",
      "特殊指标复用公开指标核心；多目标串行独立训练，排除全部目标列并共享总预算。",
      "冻结后独立预测；没有 Statigent 候选、EDA 或确认流程。",
    ],
  }),
};

export function methodManifest(id: unknown): MethodManifest {
  return structuredClone(manifests[methodIdSchema.parse(id)]);
}
export function baselineMatrix(chapter: "analysis" | "modeling"): MethodId[] {
  if (chapter !== "analysis" && chapter !== "modeling")
    throw new Error("Unknown chapter");
  return chapter === "analysis"
    ? ["react", "autogen", "datawiseagent"]
    : ["react", "autogen", "datawiseagent", "autogluon"];
}

const positive = z.number().int().positive();
const common = {
  schema_version: z.literal(1),
  image: nonempty,
  limits: z
    .strictObject({
      cpus: z.number().positive().max(256).default(2),
      memory_bytes: positive.default(4 * 1024 ** 3),
      workspace_bytes: positive.default(2 * 1024 ** 3),
      cell_timeout_ms: positive.default(120000),
      max_bundle_files: positive.max(100000).default(10000),
      max_bundle_bytes: positive.default(2 * 1024 ** 3),
    })
    .default({
      cpus: 2,
      memory_bytes: 4 * 1024 ** 3,
      workspace_bytes: 2 * 1024 ** 3,
      cell_timeout_ms: 120000,
      max_bundle_files: 10000,
      max_bundle_bytes: 2 * 1024 ** 3,
    }),
  delivery_reserve_ms: positive.default(60000),
};
// 模型和任务总额度由评测父配置冻结，不能从方法选项覆盖。
export const baselineOptionsSchema = z.discriminatedUnion("method", [
  z.strictObject({
    ...common,
    method: z.literal("react"),
    backend: z.literal("persistent-kernel").default("persistent-kernel"),
    max_turns: positive.default(30),
    prompt_version: z.literal("react-tabular-v1").default("react-tabular-v1"),
  }),
  z.strictObject({
    ...common,
    method: z.literal("autogen"),
    backend: z.literal("fresh-script").default("fresh-script"),
    max_turns: positive.default(30),
    human_input_mode: z.literal("NEVER").default("NEVER"),
    executor_llm: z.literal(false).default(false),
  }),
  z.strictObject({
    ...common,
    method: z.literal("datawiseagent"),
    backend: z.literal("persistent-kernel").default("persistent-kernel"),
    max_plan_depth: positive.default(7),
    max_execution_depth: positive.default(6),
    max_debug_depth: positive.default(8),
    max_steps: positive.default(15),
    kernel_replay: z.literal(false).default(false),
  }),
  z.strictObject({
    ...common,
    method: z.literal("autogluon"),
    backend: z.literal("automl").default("automl"),
    preset: z.literal("autogluon-cpu-v1").default("autogluon-cpu-v1"),
    num_gpus: z.literal(0).default(0),
  }),
]);
export type BaselineOptions = z.infer<typeof baselineOptionsSchema>;
export function methodConfigIdentity(value: unknown): string {
  const config = baselineOptionsSchema.parse(value);
  return sha256(
    Buffer.from(
      canonicalJson({ config, manifest: methodManifest(config.method) }),
    ),
  );
}
