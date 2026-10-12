# Spec Delta

## MODIFIED Requirements

### Requirement: Immutable offline rescoring

系统 SHALL 允许对已保存且通过完整性校验的交付物独立重新评分，记录新的评分身份、协议版本及来源关联，不修改原评分或智能体产物。重新评分 MUST 不重新运行智能体，且不将评分反馈写回智能体上下文。确定性协议的重新评分 MUST 不调用模型；使用评委的协议 MUST 由用户显式授权模型调用并提供评委预算，否则拒绝执行。

#### Scenario: Correct scoring implementation
- **WHEN** 用户使用修订的确定性评分协议重新评分已有批次
- **THEN** 产生可追溯的新评分记录，原始答案、执行成本和旧评分保持不变

#### Scenario: Submission changed after execution
- **WHEN** 已保存交付物与记录的校验值不符
- **THEN** 重新评分被拒绝并报告完整性错误

#### Scenario: Judged rescoring without authorization
- **WHEN** 用户对使用评委的批次重新评分但未显式授权模型调用或未给出评委预算
- **THEN** 重新评分在发出任何评委请求前被拒绝，原评分保持不变

#### Scenario: Authorized judged rescoring
- **WHEN** 用户显式授权并提供评委预算后重新评分
- **THEN** 产生新的评分身份及其评委用量，原评分及其评委记录保持不变

## ADDED Requirements

### Requirement: Versioned contract compatibility

评测契约 SHALL 以 v2 支持文本与报告两类输出及文件型交付。系统 MUST 继续读取、检查和重新评分 v1 评测记录，不改写既有记录；新批次一律使用 v2。不支持的契约版本 MUST 被拒绝。

#### Scenario: Inspect a v1 batch
- **WHEN** 用户检查或重新评分此前以 v1 记录的 InfiAgent 批次
- **THEN** 结果与原记录一致，原文件未被改写

#### Scenario: Unknown contract version
- **WHEN** 记录或适配器返回未知契约版本
- **THEN** 系统报告协议错误，不尝试按其他版本解释

### Requirement: Frozen file deliverables

系统 SHALL 为每个运行单元提供专属交付目录，在单元终止后校验其中文件为普通文件、路径安全、数量与大小在限制内，记录每个文件的哈希并冻结为只读。符号链接、越界路径、超限或交付后被修改的文件 MUST 使交付无效或拒绝评分。

#### Scenario: Report with images delivered
- **WHEN** 智能体交付一份报告和三张其引用的图片
- **THEN** 四个文件的哈希进入交付记录，评分端只读取冻结后的副本

#### Scenario: Deliverable is a symlink
- **WHEN** 交付目录包含指向目录外的符号链接
- **THEN** 交付被判为协议失败并保留诊断，评分端不跟随该链接

### Requirement: Grouped summary metrics

基准评分协议 SHALL 能声明分组汇总指标，指定分组键与组内及组间的聚合方式，由系统在逐单元指标之外计算。任一组含未评分或未运行单元时，该分组指标 MUST 为空并标记不完整。

#### Scenario: Case-averaged accuracy
- **WHEN** 两个案例分别有 3 题答对 2 题、7 题答对 1 题且全部评分完成
- **THEN** 题目准确率为 0.3，案例平均准确率约为 0.4048，两者分别报告

#### Scenario: Incomplete group
- **WHEN** 某案例中一题评分失败
- **THEN** 案例平均准确率为空且标记不完整，已评分单元的逐题指标仍可查看

### Requirement: Separate execution and scoring budgets

评测配置 SHALL 分别声明智能体执行预算与评委评分预算。评分预算耗尽 MUST 只阻止后续评委调用，不改变已完成单元的执行状态或智能体成本；执行预算耗尽不得消耗评分预算。

#### Scenario: Execution completes but judging stops
- **WHEN** 全部单元执行完成而评委预算在第二个单元评分时耗尽
- **THEN** 执行结果完整保留，评分覆盖率与不完整原因被分别报告
