# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Independent reusable agent configurations

同一智能体实现 SHALL 允许多个具名配置，分别记录模型、提示词版本、角色组织、执行后端与预算中实际支持的字段。配置快照 MUST 脱敏且保留可复现信息；未知字段或不支持的必需配置 MUST 被拒绝，不得静默忽略。Statigent SHALL 支持单智能体与规划—执行分离，缺省保持单智能体；两者使用持久内核，未实现的后端不能配置为已支持。

#### Scenario: Compare two configurations
- **WHEN** 同一智能体注册为两个有效配置并进入一个批次
- **THEN** 产生不同配置身份、独立执行和分别汇总的结果

#### Scenario: Unsupported future ablation
- **WHEN** 当前适配器被要求使用尚未实现的每轮新脚本后端
- **THEN** 预检明确拒绝，不以持久内核运行冒充该模式

#### Scenario: Explicit planner executor configuration
- **WHEN** 用户显式选择规划—执行分离
- **THEN** 预检和运行快照包含该组织方式、两个角色提示词、所选模型、执行后端及生效预算，实际执行不得退回单智能体

#### Scenario: Existing configuration and batch
- **WHEN** 用户运行未声明角色组织的旧配置，或检查/重评已保存的旧批次
- **THEN** 旧配置仍执行单智能体；旧批次按原适配器版本与记录解释，不改写为双角色结果

### Requirement: Unified trajectory capability

适配器 SHALL 声明是否能交付统一格式轨迹。声明支持时，轨迹 MUST 以有界、按执行顺序排列的文本给出各步代码、执行输出摘要和最终报告，不包含宿主路径、凭据或评分材料。双角色映射 SHALL 明确代码来自执行者、最终报告来自规划者，随适配器及映射版本记录，不将完整角色推理混入统一评分轨迹。

#### Scenario: Statigent trajectory from native records
- **WHEN** 单智能体 Statigent 运行完成且启用上游兼容模式
- **THEN** 适配器从原生运行记录生成统一轨迹，超过上限时截断并标记截断

#### Scenario: Trajectory not declared
- **WHEN** 智能体未声明统一轨迹能力
- **THEN** 交付中不含轨迹，兼容模式在预检时被拒绝

#### Scenario: Multiple subtasks in one trajectory
- **WHEN** 双角色运行包含多项子任务及最终报告，并请求统一轨迹
- **THEN** 全部实际代码单元按执行顺序输出一次，附最终报告及映射版本，不把角色切换伪造为 Python 单元或遗漏早期委派的代码
