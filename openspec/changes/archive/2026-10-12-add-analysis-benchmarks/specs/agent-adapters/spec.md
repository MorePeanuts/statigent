# Spec Delta

## MODIFIED Requirements

### Requirement: Statigent EDA adaptation without benchmark coupling

Statigent 适配器 SHALL 将公开任务及通用输出要求转换为现有 EDA 输入，通过现有模型配置选择供应商和模型，并关联原生运行记录。适配器 MUST 明确映射最终回答、报告及其图片和真实用量，不将题号、参考答案或评分逻辑加入核心智能体。现有单次 EDA 入口及文本交付结构 MUST 保持兼容。

#### Scenario: EDA final answer mapping
- **WHEN** EDA 完成交付
- **THEN** 适配器将 `analysis.summary` 原样作为最终回答，保留完整 analysis 及原生运行引用，不从 findings 或轨迹猜测答案

#### Scenario: Change evaluated model
- **WHEN** 用户选择符合现有模型协议与能力要求的另一模型配置
- **THEN** 同一适配器使用该配置执行并记录实际模型标识，不修改基准适配器或调度逻辑

#### Scenario: EDA report mapping
- **WHEN** 报告类型任务的 EDA 运行完成并指向引用本次图表产物的报告
- **THEN** 适配器把报告和被引用的图片复制到交付目录并保持引用在交付内可解析，未被引用的产物不进入报告交付

## ADDED Requirements

### Requirement: Directory-based deliverables

智能体适配器 SHALL 把交付文件写入运行单元专属的交付目录，由评测层冻结和评分，评分端不读取适配器返回的任意路径。外部命令仍通过有界流式协议传回文件内容，由宿主按相对文件名写入交付目录；文件名 MUST 经路径校验，单文件与总量上限 MUST 可配置并进入快照。

#### Scenario: External command delivers a report
- **WHEN** 外部命令在响应中交付报告和两张图片
- **THEN** 宿主校验名称与大小后写入交付目录，作为该单元交付冻结

#### Scenario: Unsafe or oversized file
- **WHEN** 交付文件名含父目录或绝对路径，或解码大小超过配置上限
- **THEN** 交付判为协议失败并保留诊断，交付目录不写入越界文件

### Requirement: Unified trajectory capability

适配器 SHALL 声明是否能交付统一格式轨迹。声明支持时，轨迹 MUST 以有界、按执行顺序排列的文本给出各步代码、执行输出摘要和最终报告，不包含宿主路径、凭据或评分材料。对规划与执行分离等多角色实现，映射规则 MUST 随适配器版本记录。

#### Scenario: Statigent trajectory from native records
- **WHEN** 单智能体 Statigent 运行完成且启用上游兼容模式
- **THEN** 适配器从原生运行记录生成统一轨迹，超过上限时截断并标记截断

#### Scenario: Trajectory not declared
- **WHEN** 智能体未声明统一轨迹能力
- **THEN** 交付中不含轨迹，兼容模式在预检时被拒绝
