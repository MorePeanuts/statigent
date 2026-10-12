# agent-adapters Specification

## Purpose

为待评测智能体建立统一且有边界的调用和交付契约，使 Statigent 与外部实现能够接收同一公开任务并使用同一评分端，同时保留各自的内部组织、执行产物和成本测量差异。

## Requirements

### Requirement: Agent invocation and submission contract

智能体适配器 SHALL 接收版本化公开任务、独立运行身份、显式配置、预算及取消信号，交付版本化终态、明确最终回答、产物引用和用量信息。协议、身份、类型、大小及路径 MUST 在运行时校验。Notebook、内部角色与工具结构 MUST 不是通用接入前提。

#### Scenario: Agent without Notebook
- **WHEN** 合规外部智能体提交文本回答而没有 Notebook
- **THEN** 交付可被记录及评分，Notebook 标为不适用，不伪造空 Notebook

#### Scenario: Malformed or mismatched submission
- **WHEN** 返回值版本未知、运行身份不匹配或产物引用越界
- **THEN** 适配器报告协议失败，保留有界诊断，不把该返回值视为成功交付

### Requirement: Explicit capabilities and measurement provenance

适配器 SHALL 声明支持的任务与输出类型、模型和种子配置、隔离方式、预算控制及用量测量方式。用量 MUST 区分已测量、自报告、未知和不适用，并标记来源；不适用仅限确定没有相关调用的情形。无法控制或测量的能力 MUST 明示，不得报告为已落实的公平比较条件。

#### Scenario: External agent self-reports token usage
- **WHEN** 外部实现返回自身统计的 token 数
- **THEN** 记录保留数值及自报告来源，不标为平台直接测得的用量

#### Scenario: Usage missing after failure
- **WHEN** 有模型调用可能性的智能体失败且没有返回用量
- **THEN** 用量标为未知，不能因无返回值而记为零或不适用

### Requirement: Statigent EDA adaptation without benchmark coupling

Statigent 适配器 SHALL 将公开任务及通用输出要求转换为现有 EDA 输入，通过现有模型配置选择供应商和模型，并关联原生运行记录。适配器 MUST 明确映射最终回答和真实用量，不将题号、参考答案或评分逻辑加入核心智能体。现有单次 EDA 入口及交付结构 MUST 保持兼容。

#### Scenario: EDA final answer mapping
- **WHEN** EDA 完成交付
- **THEN** 适配器将 `analysis.summary` 原样作为最终回答，保留完整 analysis 及原生运行引用，不从 findings 或轨迹猜测答案

#### Scenario: Change evaluated model
- **WHEN** 用户选择符合现有模型协议与能力要求的另一模型配置
- **THEN** 同一适配器使用该配置执行并记录实际模型标识，不修改基准适配器或调度逻辑

### Requirement: Controlled external command protocol

系统 SHALL 提供容器内外部命令接入，通过有界结构化请求和响应交换公开任务及交付，并校验退出状态、响应身份和产物。命令 MUST 来自显式受信配置；任务文本不能改变命令、挂载、网络或权限。首版此适配器 MUST 禁用网络且不注入模型密钥，联网能力请求在预检时拒绝。

#### Scenario: Offline command fixture
- **WHEN** 无模型测试智能体读取允许 CSV 并通过标准输出提交合法响应
- **THEN** 评测系统保存其回答与产物，按同一基准评分，无需导入 Statigent 内部模块

#### Scenario: Protocol violation or nonzero exit
- **WHEN** 命令输出多份响应、响应超限、异常退出或未交付就结束
- **THEN** 记录明确执行或协议失败，并在配置限制内保存诊断

### Requirement: External command isolation and cleanup

外部命令 MUST 在受限容器中运行，仅允许读取当前任务输入，限制计算资源、文件写入和执行时长，不挂载仓库、私有评分材料、宿主凭据或容器控制接口。超时与取消 MUST 终止实际任务容器而不只是客户端进程，清理只针对该运行拥有的资源。

#### Scenario: Probe private data and network
- **WHEN** 测试命令尝试读取私有标签、宿主环境或访问网络
- **THEN** 无法获得这些资源，评测仍保留可审计的运行状态

#### Scenario: Timeout with lingering work
- **WHEN** 命令超过时限且子进程仍在工作
- **THEN** 在有界清理期限内停止并删除对应容器，不影响其他运行的容器

### Requirement: Independent reusable agent configurations

同一智能体实现 SHALL 允许多个具名配置，分别记录模型、提示词版本、角色组织、执行后端与预算中实际支持的字段。配置快照 MUST 脱敏且保留可复现信息；未知字段或不支持的必需配置 MUST 被拒绝，不得静默忽略。首版未实现的角色或后端 MUST 不能被配置成已支持。

#### Scenario: Compare two configurations
- **WHEN** 同一智能体注册为两个有效配置并进入一个批次
- **THEN** 产生不同配置身份、独立执行和分别汇总的结果

#### Scenario: Unsupported future ablation
- **WHEN** 当前单智能体适配器被要求使用尚未实现的规划执行分离模式
- **THEN** 预检明确拒绝，不以单智能体运行冒充该模式
