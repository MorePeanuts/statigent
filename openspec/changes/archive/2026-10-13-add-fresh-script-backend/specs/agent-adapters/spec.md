# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
