# Spec Delta

## Purpose

通过独立的任务发布与结果评分契约接入不同基准，使任务输入、数据版本和评分口径可追溯，同时保证私有答案及评分反馈不会进入待评测智能体的执行环境或上下文。

## ADDED Requirements

### Requirement: Versioned public task and private evaluator separation

基准适配器 SHALL 提供版本化的公共任务描述，包含稳定任务身份、目标、约束、允许输入及输出契约。私有答案、评分代码与评分反馈 MUST 由独立评分端使用，不出现在智能体可见请求、目录、产物或历史上下文中。评分 MUST 在该运行单元交付冻结后进行。

#### Scenario: Prepare a task with private reference answers
- **WHEN** 系统发布包含公开 CSV 和私有参考答案的任务
- **THEN** 智能体仅获得题目、输出要求及允许的 CSV，评分端可单独访问参考答案

#### Scenario: Another repetition follows scoring
- **WHEN** 一个任务完成评分后执行另一次重复
- **THEN** 新的智能体输入不包含前次答案、分数或评分诊断

### Requirement: Allowlisted immutable input publication

基准适配器 SHALL 校验任务及文件引用，按显式允许清单发布独立输入并记录内容校验值。原始基准数据 MUST 保持只读。越界路径、符号链接、缺失文件、重复任务身份及不符合声明版本的数据 MUST 在执行前被拒绝，不得将整个基准目录交给智能体。

#### Scenario: Publish InfiAgent CSV
- **WHEN** 选定题目引用一个有效的公开表格
- **THEN** 发布区只包含该任务允许的输入，不包含其他表格、私有标签或上游文件

#### Scenario: Escaping path in benchmark metadata
- **WHEN** 文件引用通过绝对路径、父目录或符号链接指向发布根之外
- **THEN** 预检失败且智能体不会启动

### Requirement: Fixed development task selection

系统 SHALL 支持提交仅含任务身份、版本及选择规则的开发清单，并在真实模型调用前冻结。开发清单 MUST 基于公开任务信息选择、标记其用途，不按评分结果增删。正式实验清单 MUST 显式声明与已使用开发数据的关系，不能把开发结果报告为未接触的正式评测结果。

#### Scenario: Freeze a development subset
- **WHEN** 依据公开难度与任务依赖生成开发任务清单
- **THEN** 清单保留确定的任务身份、数据校验值及选择依据，无需读取答案或调用模型

#### Scenario: Attempt to change tasks after observing scores
- **WHEN** 用户改动开发清单后再次执行
- **THEN** 新计划记录不同的清单版本与校验值，旧批次仍关联原清单

### Requirement: InfiAgent task and answer contract

首个真实基准适配器 SHALL 支持本地 InfiAgent-DABench 公开问题及对应 CSV，保留题目、约束和原有 `@名称[值]` 回答要求。评分 SHALL 只读取冻结交付中的明确最终回答字段，不从完整轨迹、代码、Notebook 或参考答案推测智能体意图。

#### Scenario: Structured final answer
- **WHEN** 智能体交付包含符合题目格式的最终回答
- **THEN** 评分仅提取该最终回答中的命名字段，附加报告可保存但不成为隐藏答案来源

#### Scenario: Answer appears only in trace
- **WHEN** 最终回答缺少必需字段而调试日志包含相关数值
- **THEN** 缺失字段按错误处理，不从日志补全

### Requirement: Auditable InfiAgent scoring semantics

适配器 SHALL 按已固定上游版本的字段提取与比较语义计算逐题全对指标 ABQ 和子答案比例 PSAQ：字符串精确匹配，或数值绝对误差严格小于 `1e-6`。缺少必需字段 MUST 判错；无关字段不补偿错误。评分协议 MUST 记录上游来源、校验值、兼容行为和本地偏离，保持上游文件原样。

#### Scenario: Partially correct answer
- **WHEN** 题目要求两个字段且仅一个字段正确
- **THEN** 该题 ABQ 为 0、PSAQ 为 0.5，并保留字段级诊断

#### Scenario: Numeric boundary and duplicate fields
- **WHEN** 回答包含重复字段或数值误差位于容差边界
- **THEN** 重复字段采用上游的最后一次提取值，误差等于 `1e-6` 不判为数值相等

### Requirement: Complete denominator with explicit upstream compatibility

InfiAgent 主汇总 SHALL 以完整计划内、对应配置的题目重复单元为固定分母，每题等权计算 ABQ 与 PSAQ 均值；已终止且无有效回答的单元计零。另行提供的上游兼容汇总 SHALL 明示仅包含非空回答的范围及覆盖率。未运行或评分错误 MUST 使主汇总标记不完整且得分为空，不得静默缩小分母。

#### Scenario: Missing answer lowers primary score
- **WHEN** 两题均已终止且评分完成，一题全对、一题执行失败没有回答
- **THEN** 主 ABQ 与 PSAQ 均为 0.5；上游兼容汇总如为 1，必须同时显示仅覆盖 1/2 题及分母差异

#### Scenario: Batch stopped before second task
- **WHEN** 第一题完成而第二题因整批预算未运行
- **THEN** 保留第一题指标及计划覆盖率，完整批次主得分为空并标记不完整

### Requirement: Independent scoring failure and reproducibility

评分端 SHALL 对公共交付、私有材料和评分输出实施运行时校验，区分回答错误与评分基础设施故障。确定性评分 MUST 在同一交付、数据和评分版本下可离线复算，不依赖智能体内部实现。评分详细材料 MUST 留在评分侧，不作为后续智能体执行输入。

#### Scenario: Invalid reference material
- **WHEN** 私有标签不符合评分契约或无法匹配选定题目
- **THEN** 预检或评分报明确错误，不生成伪造的零分或成功评分

#### Scenario: Same answer from two agent implementations
- **WHEN** 两个不同智能体交付相同最终回答并使用相同任务及评分版本
- **THEN** 得到相同的基准指标，无需两者共享 Notebook、工具接口或轨迹结构
