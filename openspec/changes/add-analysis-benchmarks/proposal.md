# Proposal

## Why

第一章的主基准 DAComp-DA 与辅助基准 DSBench-Analysis 都依赖 LLM 评委，DAComp 还要求交付带图表的报告。现有评测契约只支持文本回答、内联小产物和确定性免费评分，无法接入这两套基准。规划/执行分离和脚本后端的消融需要在有区分度的任务上比较；如果不先确定报告交付和评委评分口径，后续方法实现可能需要返工。因此先泛化契约，并接入这两套第一章基准。

## What Changes

- 评测契约升级为 v2：输出类型在文本之外新增“报告”（Markdown 及其引用的图片）；产物从 base64 内联改为单元专属目录中的文件交付，并校验哈希与大小。v1 评测记录仍可只读检查和重评。
- 新增 LLM 评委评分：基准声明评委角色及其所需能力（文本/视觉），评测配置把角色映射到具名模型 profile。评委调用有独立的预算、重试上限和记账，与智能体成本分开报告。评委失败记为评分错误，不计 0 分。
- **BREAKING（语义）**：对使用评委的协议，重新评分会产生付费调用。必须显式授权并提供预算；确定性协议的离线重评保持免费。
- 汇总支持基准声明的分组指标，例如 DSBench 的案例平均准确率。跨方法汇总（如 TabArena）只在设计中预留扩展点，不实现。
- 模型 profile 新增视觉能力，请求支持“文本 + 图片”内容片段，首版只实现 chat-completions 的 `image_url` data URL 格式。评委调用可以不带工具。DeepSeek `deepseek-flash` 作为首个视觉评委配置。
- 接入 DAComp-DA：发布 SQLite 和任务说明；主口径只把最终报告和图表交给评委，复用上游 rubric 与 GSB 的 prompt、解析和 0.6/0.1/0.1/0.2 加权；可选的上游兼容模式额外用统一格式的轨迹再做一次 rubric 评分，分开报告。
- 接入 DSBench-Analysis：按题作为运行单元，发布案例说明、题目及允许的数据文件（排除可能含解答的 Notebook）。使用上游语义一致判定 prompt，报告题目准确率与案例平均准确率。
- Statigent EDA 支持报告输出：任务要求报告时，模型提交引用本次产物的 Markdown 报告，宿主校验图片引用并交付。提示词版本随之更新；文本任务的行为保持兼容。
- 执行镜像加入 Excel（xlsx/xlsm/xlsb）读取依赖；为两套基准各冻结一份小型开发清单和真实冒烟配置。

## Capabilities

### New Capabilities

- `judge-scoring`: LLM 评委角色声明、模型配置映射、能力预检、有界调用与重试、独立记账、评分侧记录，以及评委失败与随机性的报告口径。

### Modified Capabilities

- `evaluation-harness`: 契约 v2 及 v1 记录兼容、报告/文件交付的冻结、评委预算与成本分列、分组汇总、有付费调用的重评授权。
- `benchmark-adapters`: 输出契约类型扩展；新增 DAComp-DA 与 DSBench-Analysis 的任务发布、评分语义、主口径/兼容口径和上游偏离记录。
- `agent-adapters`: 文件型交付与报告映射、统一轨迹能力声明、Statigent 报告交付。
- `model-access`: 视觉能力声明、多模态内容片段校验、无工具调用。
- `eda-agent`: 结构化交付在任务要求时包含引用本次产物的报告。

## Impact

- 代码：`src/evaluation/`（契约、记录、运行器、汇总、评委评分、两个新基准适配器、Statigent 与外部命令适配器）、`src/models/`、`src/agent/`（finish 动作、提示词、报告渲染）、`python/statigent_evaluation/`（DAComp/DSBench 的 prompt 构造、结果解析与加权移植）。
- 依赖：执行镜像新增 Excel 读取库，导致镜像 ID 变化；评分侧不引入 openai/loguru 等上游运行依赖，只移植纯函数，并对未修改的上游代码做差分测试。
- 配置：`configs/models.json` 新增评委 profile；`configs/evaluations/` 新增两套开发与冒烟配置。
- 成本：真实冒烟会产生智能体和评委两类付费调用，预算与授权都要显式给出。默认检查不调用付费 API。
- 不在范围内：建模基准、TabArena 跨方法汇总、规划/执行分离、脚本后端、除 chat-completions `image_url` 以外的多模态协议、正式实验的评委选择与重复评分次数、联网外部智能体、并行调度。
