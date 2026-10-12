# evaluation-harness Specification

## Purpose

为不同基准与不同智能体提供统一、可复现的评测执行入口，管理任务计划、预算、生命周期和独立评测记录，并以明确的失败与成本口径生成可追溯的比较结果。

## Requirements

### Requirement: Explicit reproducible evaluation plan

系统 SHALL 从显式配置解析单个基准的固定任务集合、智能体配置列表、重复次数、种子及预算，形成稳定排序的完整运行计划。每个任务、智能体配置和重复序号组合 MUST 有独立身份。计划预览 SHALL 不调用模型、不启动智能体或自动下载数据。

#### Scenario: Preview a comparison
- **WHEN** 用户预览包含 2 个任务、2 个智能体配置和 3 次重复的有效配置
- **THEN** 输出包含 12 个运行单元、有效配置和任务版本的计划，不发生模型调用或任务执行

#### Scenario: Invalid task selection
- **WHEN** 配置引用未知、重复或版本校验失败的任务
- **THEN** 预检失败并指出原因，不静默替换任务或开始执行

### Requirement: Independent extension and capability preflight

系统 SHALL 分别注册基准适配器和智能体适配器，通过公共契约组合二者。执行前 MUST 校验配置及必需能力，包括输出类型、模型配置、隔离方式和预算支持。不能满足的必需约束 MUST 拒绝执行；可选能力缺失 MUST 显式记录，不得默认为支持。

#### Scenario: New adapter combinations
- **WHEN** 两个合规基准适配器分别与两个合规智能体适配器组合运行
- **THEN** 四种组合均由同一调度流程执行，无需为组合新增调度分支

#### Scenario: Unsupported model control
- **WHEN** 计划要求统一模型配置而某智能体声明不支持该配置
- **THEN** 整个计划在首次任务执行前被拒绝，诊断标明不兼容项

### Requirement: Serial execution and isolated attempts

系统 SHALL 串行执行计划，每个运行单元具有独立输入、输出和智能体会话，且最多自动启动一次。单元失败 MUST 保留记录并按既定计划处理后续单元，不得自动重跑直到成功或复用另一单元的内核、答案或历史产物。

#### Scenario: Failed unit followed by another task
- **WHEN** 一个单元明确失败且预算、隔离及记录仍可靠
- **THEN** 失败结果被保留，后续单元使用新会话执行，失败单元不自动重试

#### Scenario: Repeated task
- **WHEN** 同一任务进入第二次重复
- **THEN** 使用新的运行身份与工作目录，不继承第一次执行状态

### Requirement: Task and batch budget accounting

系统 SHALL 同时记录并执行声明支持的逐任务及整批时间、模型尝试次数和 token 停止阈值，将智能体内部重试计入实际用量。token 阈值 MUST 标明是在响应结算后停止而非精确账单上限。未知用量 MUST 保留已知小计；影响整批成本约束时 MUST 停止后续派发。货币成本无价格依据时 MUST 标为未计算。

#### Scenario: Exhausted batch budget
- **WHEN** 已结算用量达到整批阈值
- **THEN** 不再启动后续单元，剩余计划单元记录为未运行并附预算原因

#### Scenario: Interrupted model request has unknown usage
- **WHEN** 智能体记录包含可能已计费但无法确认用量的请求
- **THEN** 汇总保留已知 token 小计及未知请求数，不将未知请求计为零；依赖完整成本约束的批次停止派发

### Requirement: Bounded cancellation and failure visibility

系统 SHALL 将取消或批次超时传递给当前智能体，在有界时间内清理其受控资源，停止派发并保留已完成产物。清理或关键记录失败 MUST 阻止继续运行并输出诊断。异常退出后遗留的执行中单元 MUST 显示为状态未确认，不得推断成功、自动恢复或再次调用模型。

#### Scenario: Cancel during execution
- **WHEN** 用户取消正在执行的批次
- **THEN** 当前单元收到取消信号，资源清理结果被记录，后续单元标为未运行

#### Scenario: Inspect interrupted batch
- **WHEN** 进程意外退出后用户查看批次记录
- **THEN** 未完成单元显示状态未确认及最后可靠事件，查看过程不启动新的任务

### Requirement: Separate versioned evaluation records

系统 SHALL 在执行智能体前持久化独立的版本化评测身份、计划及配置快照，关联任务、智能体运行和评分记录。快照 MUST 记录代码版本及脏状态、适配器与评分协议版本、数据校验值、模型配置、种子、环境与预算，且不含密钥。既有执行清单和代码重放语义 MUST 保持兼容。

#### Scenario: Agent fails before allocating its own run
- **WHEN** 适配器调用的智能体在创建内部运行记录前报错
- **THEN** 评测单元仍有唯一身份、失败状态和诊断，内部运行引用可以为空

#### Scenario: Link existing Statigent run
- **WHEN** Statigent 产生其原生运行记录
- **THEN** 评测记录引用该运行及交付物，不改写原生清单或伪造 Notebook 记录

### Requirement: Distinct execution scoring and coverage outcomes

系统 SHALL 分开记录执行状态、评分状态、预算合规性和成本完整性，输出逐单元 JSON/CSV 及按基准、评分协议和智能体配置分组的汇总。终止失败且无有效交付的单元 MUST 按基准规则计入计划分母；评分系统错误 MUST 记为未知而非错误答案。未运行或评分未完成的批次 MUST 标为不完整，不发布完整批次得分。

#### Scenario: Completed agent produces wrong answer
- **WHEN** 智能体正常结束但基准评分为错误
- **THEN** 执行状态为完成，答案指标为失败，两者分别统计

#### Scenario: Evaluator cannot read private labels
- **WHEN** 评分所需私有材料损坏或缺失
- **THEN** 评分状态为失败且指标为空，报告显示覆盖率与不完整状态，不把该任务按零分汇总为完整结果

#### Scenario: Incompatible metrics
- **WHEN** 导出的结果包含不同评分协议或不可比的配置
- **THEN** 保持分别分组并指出不可比原因，不自动平均为统一总分

### Requirement: Immutable offline rescoring

系统 SHALL 允许对已保存且通过完整性校验的交付物独立重新评分，记录新的评分身份、协议版本及来源关联，不修改原评分或智能体产物。离线重新评分 MUST 不重新运行智能体、不调用模型，且不将评分反馈写回智能体上下文。

#### Scenario: Correct scoring implementation
- **WHEN** 用户使用修订的确定性评分协议重新评分已有批次
- **THEN** 产生可追溯的新评分记录，原始答案、执行成本和旧评分保持不变

#### Scenario: Submission changed after execution
- **WHEN** 已保存交付物与记录的校验值不符
- **THEN** 重新评分被拒绝并报告完整性错误

### Requirement: Explicit evaluation entry points

系统 SHALL 提供计划预览、执行、查看和离线评分入口。快速检查及默认测试 MUST 使用合成数据与可控响应，不调用付费 API、不下载大数据。真实评测 MUST 经显式执行入口指定固定任务集合及预算，开发集合和正式评测集合 MUST 在记录中区分。

#### Scenario: Credentials exist during routine tests
- **WHEN** 本地环境存在真实模型密钥而用户运行默认检查
- **THEN** 不调用真实模型或自动执行基准

#### Scenario: Explicit development smoke run
- **WHEN** 用户显式运行固定开发冒烟配置
- **THEN** 仅执行该配置的任务、重复次数和预算，并标记为开发结果
