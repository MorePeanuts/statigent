# Proposal

## Why

第二章已有自主建模与 EDA 协同闭环，但统一评测仅接入分析基准，建模真实开发验证仍依赖单独的 s3e9 入口。需要接入 DSBench-Modeling 与 TabArena-Lite，覆盖已下载候选所需的全部指标与预测形式，让固定小型真实任务可用于开发比较，并在正式实验前暴露协议、隔离和资源问题。

## What Changes

- 审计 DSBench 的 52 项下载候选和 TabArena-Lite v0.1 的 51 项数据，生成版本化任务目录、来源清单、支持状态与问题记录；下载候选、开发集合、正式集合分别管理，不预设全部候选都应纳入论文。
- 实现两套基准的数据准备、阶段化输入发布、预测导出、独立评分和汇总。DSBench 保留发布外层划分、逐题评分实现与 RPG 参考；TabArena 保留官方 r0f0 外层索引，并核验自主管理验证与搜索的 system 协议。
- 覆盖全部候选实际需要的指标：RMSE、MAE、MedAE、RMSLE、R²、SMAPE、accuracy、ROC AUC、log-loss、normalized Gini、quadratic weighted kappa、micro-F1、前三候选命中及多目标平均 AUC；冻结公式、标签/顺序、边界和上游偏离。
- 扩展建模协议，贯通有序类别、多目标二分类和前三候选输出的训练、验证、EDA 诊断、终局确认、交付及独立复现；四种方法共享相同能力和资源口径。
- 扩展统一评测的预测交付与无固定上下界指标，新增 Statigent 建模适配器，复用计划、串行执行、预算、取消、冻结交付和离线重评，不建立第二套批量调度器。
- 提供全候选无模型审计/预检、按显式资源执行的确定性模型验证、小型真实任务开发清单及四方法配置，分列软件验收、真实模型验收与正式实验。
- **BREAKING**：新预测任务和新增指标使用新版数据/预测/评测契约，旧适配器不能凭名称宣称支持。旧分析配置及既有建模记录继续按原版本读取、检查、评分和复现，不原地迁移或改变历史数值规则。

## Capabilities

### New Capabilities

- `modeling-metrics`: 版本化建模指标定义、预测语义、数值边界及可信计算，供搜索、确认和独立测试共享。

### Modified Capabilities

- `benchmark-adapters`: 两套建模基准的全候选审计、数据准备、输入隔离、逐题评分和基准汇总。
- `agent-adapters`: 建模适配器、预测交付及四方法开发配置。
- `evaluation-harness`: 新版预测任务契约、分阶段输入、指标边界、固定分母和建模结果报告。
- `modeling-agent`: 扩展任务与指标范围、通用目标语义及多目标/排序输出的 EDA 交接。
- `modeling-experiments`: 新版目标和预测协议、冻结划分、训练确认与复现的端到端支持。
- `execution-records`: 新协议事实、多目标诊断和基准交付身份的记录与旧版本兼容。

## Impact

- 主要涉及 `src/evaluation/`、`src/modeling/`、`python/statigent_modeling/`，新增基准数据准备/评分模块；核心智能体不得增加基准任务 ID 分支。
- 更新建模与评测配置、来源清单、合成夹具、上游差分及 Docker 集成验收，补充 `docs/modeling.md`、`docs/evaluation.md`、`docs/benchmark.md` 和独立验收记录；研究范围变化通过文档明确，不改写历史验收。
- ARFF/Parquet 解码及固定版本 TabArena 兼容验证可能需要受 uv 锁定的依赖或独立可选验证环境；训练镜像只增加生成代码实际需要的依赖，不引入自动下载或付费调用。
- 本变更不执行完整正式实验、不接入全部外部研究基线、不改变四组协同机制、不新增线上裁判或上下文压缩；实际付费验收需独立指定任务、方法及预算。
