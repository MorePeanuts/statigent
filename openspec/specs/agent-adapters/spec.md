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

Statigent 适配器 SHALL 将公开任务及通用输出要求转换为所选组织方式的 EDA 输入，通过现有模型配置选择供应商和模型，并关联原生运行记录。适配器 MUST 明确映射最终回答、报告及其图片和真实总用量，不将题号、参考答案或评分逻辑加入核心智能体。现有单次 EDA 入口及文本交付结构 MUST 保持兼容；双角色只产生一个 EDA 交付和一份全任务成本，不把子任务结果当作独立答案。

#### Scenario: EDA final answer mapping
- **WHEN** EDA 完成交付
- **THEN** 适配器将 `analysis.summary` 原样作为最终回答，保留完整 analysis 及原生运行引用，不从 findings 或轨迹猜测答案

#### Scenario: Change evaluated model
- **WHEN** 用户选择符合现有模型协议与能力要求的另一模型配置
- **THEN** 同一适配器使用该配置执行并记录实际模型标识，不修改基准适配器或调度逻辑；双角色中的两个角色均使用所选模型

#### Scenario: EDA report mapping
- **WHEN** 报告类型任务的 EDA 运行完成并指向引用本次图表产物的报告
- **THEN** 适配器把报告和被引用的图片复制到交付目录并保持引用在交付内可解析，未被引用的产物不进入报告交付

#### Scenario: Planner owns final submission
- **WHEN** 双角色 EDA 接受规划者最终结果，之前已有多项子任务返回
- **THEN** 适配器仅交付最终结果，测得用量包含两个角色及其重试，不再次叠加子任务小计

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

同一智能体实现 SHALL 允许多个具名配置，分别记录模型、提示词版本、角色组织、执行后端与预算。配置快照 MUST 脱敏且保留可复现信息；未知字段或不支持的必需配置 MUST 被拒绝，不得静默忽略。Statigent SHALL 支持单智能体与规划—执行分离分别组合 persistent-kernel 与 fresh-script，缺省保持单智能体与持久内核；后端必须实际透传到执行层，不能只改展示名称。

#### Scenario: Compare two configurations
- **WHEN** 同一智能体注册为两个有效配置并进入一个批次
- **THEN** 产生不同配置身份、独立执行和分别汇总的结果

#### Scenario: Unsupported future ablation
- **WHEN** 当前适配器被要求使用未知后端或镜像不支持的后端
- **THEN** 预检在模型调用前明确拒绝，不以其他后端冒充该模式

#### Scenario: Explicit planner executor configuration
- **WHEN** 用户显式选择规划—执行分离
- **THEN** 预检和运行快照包含该组织方式、两个角色提示词、所选模型、执行后端及生效预算，实际执行不得退回单智能体

#### Scenario: Existing configuration and batch
- **WHEN** 用户运行未声明角色组织的旧配置，或检查/重评已保存的旧批次
- **THEN** 旧配置仍执行单智能体；旧批次按原适配器版本与记录解释，不改写为双角色结果

### Requirement: Directory-based deliverables

智能体适配器 SHALL 把交付文件写入运行单元专属的交付目录，由评测层冻结和评分，评分端不读取适配器返回的任意路径。外部命令仍通过有界流式协议传回文件内容，由宿主按相对文件名写入交付目录；文件名 MUST 经路径校验，单文件与总量上限 MUST 可配置并进入快照。

#### Scenario: External command delivers a report
- **WHEN** 外部命令在响应中交付报告和两张图片
- **THEN** 宿主校验名称与大小后写入交付目录，作为该单元交付冻结

#### Scenario: Unsafe or oversized file
- **WHEN** 交付文件名含父目录或绝对路径，或解码大小超过配置上限
- **THEN** 交付判为协议失败并保留诊断，交付目录不写入越界文件

### Requirement: Unified trajectory capability

适配器 SHALL 声明是否能交付统一格式轨迹。声明支持时，轨迹 MUST 以有界、按执行顺序排列的文本给出各步代码、执行输出摘要和最终报告，不包含宿主路径、凭据或评分材料。映射 SHALL 标明执行后端及单元或完整脚本语义；双角色明确代码来自执行者、最终报告来自规划者。映射版本随适配器记录，不将完整角色推理混入统一评分轨迹，也不伪造脚本组共享内核。

#### Scenario: Statigent trajectory from native records
- **WHEN** 单智能体 Statigent 运行完成且启用上游兼容模式
- **THEN** 适配器从原生运行记录生成统一轨迹，超过上限时截断并标记截断

#### Scenario: Trajectory not declared
- **WHEN** 智能体未声明统一轨迹能力
- **THEN** 交付中不含轨迹，兼容模式在预检时被拒绝

#### Scenario: Multiple subtasks in one trajectory
- **WHEN** 双角色运行包含多项子任务及最终报告，并请求统一轨迹
- **THEN** 全部实际代码单元按执行顺序输出一次，附最终报告及映射版本，不把角色切换伪造为 Python 单元或遗漏早期委派的代码

### Requirement: EDA execution budget passthrough

Statigent 适配器 SHALL 接受并校验原生 EDA 的代码执行、修复、动作纠正、限流重试、单请求时限和消息/轨迹大小预算配置，预检与运行快照 SHALL 记录生效值。未指定字段保持既有默认值。原生选项 MUST NOT 覆盖统一评测传入的模型尝试次数、总 token 或任务剩余时限，不得为两角色分别复制整份任务额度。

#### Scenario: Configure more than eight executions
- **WHEN** 评测配置为 Statigent 显式设置 12 次代码执行且配置有效
- **THEN** EDA 收到 12 次全任务执行额度，单角色和双角色均不静默退回默认 8 次

#### Scenario: Batch has less remaining budget
- **WHEN** 统一评测传入的单元模型次数、token 或时限因整批余额而缩小
- **THEN** EDA 使用缩小后的全任务额度，角色切换不会恢复到原始配置值

#### Scenario: Conflicting or invalid native budget
- **WHEN** 原生选项包含模型次数覆盖、未知字段或非法执行上限
- **THEN** 预检拒绝配置，不能静默覆盖评测预算或调用模型

### Requirement: 第一章四组开发对照配置

系统 SHALL 提供单角色/双角色与持久内核/独立脚本的四组开发评测配置，使用相同任务、模型、依赖镜像、种子和逐任务预算，显式记录允许任务内文件复用及所选后端。整批预算须覆盖计划中的所有组，保留既有缩减/未运行标记；结果按配置分别汇总，不将预算不同或缩减组报告为同预算对照。原开发配置与历史结果不得覆盖。

#### Scenario: 预览四组计划
- **WHEN** 用户预览含 N 个固定开发任务、四种配置和 R 次重复的计划
- **THEN** 展示 4×N×R 个独立单元及其后端、角色、提示、文件策略和有效预算，不调用模型或下载数据

#### Scenario: 两种脚本组织都能交付
- **WHEN** 单角色或双角色脚本配置完成报告任务
- **THEN** 同一评测流程接受最终报告和合法图片，保留原生脚本运行及完整用量，未因没有 Notebook 而拒绝交付

#### Scenario: 整批预算不足
- **WHEN** 后续配置的有效预算被整批余量缩小或无法派发
- **THEN** 报告标记缩减或未运行及不完整性，不与完整额度组混称为公平对照

### Requirement: 脚本对照的显式验收入口

默认检查 SHALL 以合成数据和可控模型响应验收四组的隔离、输出、证据、预算和终态。真实模型冒烟 SHALL 经独立入口显式选择组织方式、冻结任务、模型及有限预算，保留每次失败且不自动追加运行。四组配置准备完成不等于真实模型验收或研究收益成立。

#### Scenario: 常规验收不消费 API
- **WHEN** 环境存在模型密钥且开发者运行快速或 Docker 集成检查
- **THEN** 四组均使用可控模型响应，不触发付费模型或评委请求

#### Scenario: 选择一次脚本冒烟
- **WHEN** 操作者明确选择 fresh-script 的一种角色组织及固定任务和预算
- **THEN** 仅运行该选定范围，检查新进程、文件复用、证据及交付，成功不要求胜过持久组，失败不换题或自动加跑

#### Scenario: 仅预检冒烟配置
- **WHEN** 操作者选择冒烟预检
- **THEN** 校验固定输入、组织、后端与预算并报告计划，不调用模型、不启动执行任务
