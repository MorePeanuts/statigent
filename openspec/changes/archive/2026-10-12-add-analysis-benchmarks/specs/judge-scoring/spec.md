# Spec Delta

## Purpose

为依赖 LLM 评委的基准提供可配置、有边界且可审计的评分能力，使评委模型、调用成本、随机性和失败与待评测智能体分开记录，不把评委故障或配置缺陷误报为智能体成绩。

## ADDED Requirements

### Requirement: Declared judge roles and configurable models

使用评委的基准评分协议 SHALL 声明各评委角色及其所需能力（如文本或视觉）。评测配置 SHALL 将每个角色映射到具名模型配置；协议版本、角色映射、模型请求名与展示名、生成参数和 prompt 版本 MUST 进入评分记录。未映射的角色或未知模型配置 MUST 在执行任何智能体前被拒绝。

#### Scenario: Map judge roles to a custom profile
- **WHEN** 配置将文本与视觉评委角色映射到同一个声明支持视觉的模型配置
- **THEN** 计划预检通过，评分记录保存该映射和有效参数，无需修改基准适配器

#### Scenario: Missing role mapping
- **WHEN** 评分协议声明了视觉评委角色但配置没有映射它
- **THEN** 预检失败并指出缺失角色，不启动智能体

### Requirement: Judge capability preflight

系统 SHALL 在执行前核对每个评委角色所需能力与所映射模型配置的声明能力。能力不满足 MUST 拒绝整个计划，不得跳过该评分项、改用其他模型或把该项记为零分。

#### Scenario: Text-only model for visual comparison
- **WHEN** 可视化比较角色映射到未声明视觉能力的模型配置
- **THEN** 计划在首个单元执行前被拒绝，诊断说明能力不足

### Requirement: Bounded judge calls and retries

每次评委调用 SHALL 受请求时限、发送与接收大小、输出 token 上限和取消约束。无法解析的评委输出 SHALL 只在配置的有限次数内重新请求；所有尝试，包括失败和无法解析的尝试，MUST 逐次记录并计入评分用量。

#### Scenario: Unparseable judge output
- **WHEN** 评委连续返回无法按协议解析的内容直到达到重试上限
- **THEN** 该评分项状态为评分错误，所有尝试的用量与有界原始响应被保留，不继续重试

### Requirement: Judge failure is a scoring error

评委调用失败、能力不足、解析失败或评分预算耗尽 SHALL 使对应单元的评分状态为失败，该单元在主汇总中按评分未完成处理。系统 MUST NOT 把评委侧故障按智能体答错或零分计入。基准规则明确规定的智能体侧缺失，例如报告不含图片，仍按该规则计分。

#### Scenario: Judge service times out
- **WHEN** 某单元的评委请求超时且没有剩余重试
- **THEN** 该单元评分失败、批次主得分为空并标记不完整，执行状态与智能体用量不变

#### Scenario: Agent report has no images
- **WHEN** 智能体交付的报告不含任何图片而协议规定此时可视化项为零
- **THEN** 可视化项按协议计零且无需视觉评委调用，评分状态为完成

### Requirement: Separate judge cost accounting

系统 SHALL 按评分身份分别记录评委的请求次数、输入/输出 token、未知用量和耗时，在报告中与智能体用量分列。评委 MUST 有独立的逐单元及整次评分预算；耗尽时停止后续评委调用并标记评分不完整。货币成本无价格依据时 MUST 标为未计算。

#### Scenario: Report agent and judge usage
- **WHEN** 一个批次完成执行与评委评分
- **THEN** 汇总分别显示智能体 token 与评委 token，不把两者合并为单一成本

#### Scenario: Judge budget exhausted mid-scoring
- **WHEN** 评委 token 已达到整次评分阈值而仍有单元未评分
- **THEN** 后续单元不再发起评委调用，其评分状态为未完成并附预算原因

### Requirement: Scoring-side judge records

评委请求所含的评分细则、参考报告、参考答案及评委响应 SHALL 只保存在评分侧记录中，不进入智能体输入、工作目录或后续单元上下文。评委请求 MUST 使用宿主受控凭据，不向智能体容器或评分子进程暴露密钥。

#### Scenario: Next repetition after judged scoring
- **WHEN** 已完成评委评分的任务进入下一次重复
- **THEN** 新单元的输入不包含评分细则、参考报告、评委响应或分数

### Requirement: Disclosed judge nondeterminism and bias

使用评委的评分结果 SHALL 标明其为模型判定、非确定性评分，记录服务返回的模型名及指纹（若有）。当评委与被评测智能体使用相同模型配置时，记录 MUST 标出可能的自评偏差。同一交付的两次评委评分不得被假定为相同。

#### Scenario: Same model as agent and judge
- **WHEN** 评委角色与被评测智能体映射到同一模型请求名
- **THEN** 评分记录与报告包含自评偏差标记

#### Scenario: Repeated judged scoring differs
- **WHEN** 同一交付经两次评委评分得到不同指标
- **THEN** 两次结果作为不同评分身份分别保留，不覆盖或静默取平均
