# Proposal

## Why

两章完整方法、主要消融及五套基准的评测链路已具备，但缺少可在同一协议下运行的外部对比方法。需要接入 ReAct、AutoGen、DatawiseAgent，以及第二章的 AutoGluon，使正式实验能够比较任务表现与实际开销，而不把链路测试方法或论文原始分数当成本机 baseline。

## What Changes

- 第一章提供 ReAct、AutoGen、DatawiseAgent 三种对照，覆盖 InfiAgent-DABench、DSBench-Analysis、DAComp-DA；第二章提供上述三种 Agent 和 AutoGluon，覆盖 DSBench-Modeling 与 TabArena-Lite 的公开目标/预测协议。
- 固定方法身份与可复现配置：ReAct 采用单 Agent 工具循环；AutoGen 使用官方双代理代码助手/执行代理配置；DatawiseAgent 保留官方规划、增量执行、自调试及过滤；AutoGluon 使用官方表格训练接口和明确的特殊目标映射。
- 新增受宿主管理的 baseline 运行桥接：统一模型调用、预算和隔离执行；上游编排可运行在独立锁定 Python 环境，生成代码只在无网络、无凭据的受限容器执行。保持旧 `container-command` 的离线语义。
- 增加与 Statigent 实验记录解耦的版本化预测交付及冻结模型引用，复用阶段输入发布、原指标、导出和重评；不要求外部方法伪造 Statigent 候选、笔记或确认流程。
- 提供方法来源/偏离清单、能力预检、开发比较配置、零付费自动检查及显式真实冒烟入口，分别报告软件接入、真实验收、预测复现和研究效果。
- 实施时同步研究文档的 baseline 名单，移除纯 LLM 对照。保留既有消融；不新增其他研究方法，不开展正式全量实验，不在本变更中冻结正式任务集或宣称方法收益。

## Capabilities

### New Capabilities

- `research-baselines`: 四种研究对比方法的身份、方法边界、目标适配、来源与依赖锁定，以及开发验收要求。

### Modified Capabilities

- `agent-adapters`: 增加受控 baseline 桥接、宿主模型调用与执行权限、外部方法冻结交付及预测复现契约；现有离线命令适配器不升级权限。
- `evaluation-harness`: 增加混合 Agent/AutoML 比较配置、方法差异披露及版本化外部预测的评分/比较兼容。

## Impact

- 预期新增 `src/baselines/`、`python/statigent_baselines/`、`environments/baselines/` 下按方法隔离的依赖环境及受信来源清单；按需新增 Docker 构建文件和开发配置。
- 主要接入点为 `src/evaluation/registry.ts`、`agents/`、`predictions.ts`、建模适配器、`report.ts` 和 `cli.ts`；复用 `src/models/`、`src/execution/`、数据准备与指标核心，不复制基准评分。
- AutoGen、DatawiseAgent 和 AutoGluon 为显式可选依赖，不进入默认轻量运行环境；实际包版本、上游 commit、许可、锁文件与镜像摘要在实现期通过兼容探针后提交，禁止运行时自动升级或安装。
- 新增协议使用独立版本，保留既有 v1/v2/v3 评测记录、预测清单 v1 和离线命令协议的读取/重评，不修改历史批次。
- 修改范围包含相关行为测试、真实 Docker 集成测试和使用/验收文档；默认检查不调用付费 API、不训练完整真实基准。
