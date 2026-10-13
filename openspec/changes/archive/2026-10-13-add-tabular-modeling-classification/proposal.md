# Proposal

## Why

第二章已跑通单目标回归/RMSE 的分析—建模协作，但数据校验、预测执行、最佳模型比较、EDA 交接和交付复现仍写死回归语义，无法按照原研究架构处理表格分类。本变更先补齐通用系统能力，使同一建模循环支持回归、二分类和多分类，为后续训练预算调度及完整流程完善提供基础。

## What Changes

- 引入版本化表格任务协议，覆盖 regression/rmse、binary/accuracy/roc_auc/log_loss、multiclass/accuracy/log_loss；预检确定指标方向、预测类型、类别顺序和二分类正类。
- 从允许训练数据生成并冻结分类标签映射和可复现分层内部划分，显式划分也校验类别覆盖；保留现有回归输入与划分行为。
- 扩展隔离训练/预测执行及可信评分，支持类别标签和概率矩阵，按统一协议校验样本、类别与概率并选择最佳实验。
- 将任务协议、分类预测和概率语义贯通建模提示词、定向 EDA、证据来源、模型交付、独立复现及已有离线评分入口。
- 版本化新建模记录，保留历史回归数据、父运行及交付的读取、检查和按原条件复现；不原地迁移旧记录。
- 提供小型合成数据的确定性测试、真实 Docker 整链验收，以及显式有界的分类模型冒烟入口。

本轮不增加训练额度自适应、子采样搜索、交叉验证、分类阈值搜索、新 LLM 角色、消融模式、AutoML 基线或 Benchmark 适配，也不开展正式方法效果实验。内部验证指标与已有独立评分入口的扩展属于系统完整性，不改变“系统先行、评测适配后置”的顺序。

## Capabilities

### New Capabilities

无；沿用现有建模能力边界。

### Modified Capabilities

- `modeling-agent`: 接受分类任务，按任务协议构造模型上下文、比较候选并委派分类诊断，维持原预算和协作边界。
- `modeling-experiments`: 扩展任务/划分、标签/概率契约、可信指标、EDA 数据交接、最终交付与复现。
- `execution-records`: 记录冻结任务协议和通用指标，核对分类证据与最佳选择，同时兼容历史回归记录。

## Impact

主要影响 `src/modeling/` 的 data、experiments、actions、run、candidates、eda、records、delivery、cli 和 smoke，以及 `python/statigent_modeling/runner.py`。新增协议/预测/评分模块可在该目录内拆分，继续使用现有 Bun/TypeScript、uv/Python、scikit-learn 与 Docker；预计不新增依赖。

同步相关建模单元及集成测试、小型合成夹具、`configs/modeling/` 示例和 `docs/modeling.md`。新记录字段需要显式版本分派，外部读取新记录时应使用新协议；旧任务配置和历史产物保留兼容。统一评测注册表、上游评分资源、原始基准数据和 EDA 核心角色协议不在修改范围。
