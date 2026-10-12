# benchmark-adapters Specification

## Purpose

通过独立的任务发布与结果评分契约接入不同基准，使任务输入、数据版本和评分口径可追溯，同时保证私有答案及评分反馈不会进入待评测智能体的执行环境或上下文。

## Requirements

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

### Requirement: Typed output contracts

公共任务的输出契约 SHALL 声明输出类型及公开格式说明，至少支持文本回答与报告。报告类型 MUST 指定报告文件名、允许的图片格式及数量与大小上限。智能体未声明支持该输出类型时，计划 MUST 在执行前被拒绝。

#### Scenario: Report task for a text-only agent
- **WHEN** DAComp 报告任务与只声明文本输出的智能体配置组合
- **THEN** 预检拒绝该组合并指出输出类型不兼容

### Requirement: DAComp-DA task publication

DAComp-DA 适配器 SHALL 从本地固定版本读取任务说明，只发布对应任务的 SQLite 数据库，并要求交付英文 Markdown 报告及其引用图片。评分细则、元数据、参考报告与参考图片 MUST 只供评分端使用。

#### Scenario: Publish a DAComp task
- **WHEN** 选定 `dacomp-002`
- **THEN** 智能体只获得任务说明、报告输出要求和 `dacomp-002.sqlite`，看不到 rubric 或参考报告

#### Scenario: Database changed on disk
- **WHEN** 本地 SQLite 的校验值与记录的数据版本不符
- **THEN** 预检失败，智能体不启动

### Requirement: DAComp primary report-only scoring

DAComp 主口径 SHALL 只把冻结的报告及其引用图片交给评委，按上游 rubric 计算内容得分率，按与参考报告的两两比较计算可读性、专业性和可视化得分，并以上游 0.6/0.1/0.1/0.2 权重得到 0–100 总分。轨迹、代码与 Notebook MUST NOT 进入主口径评委输入。

#### Scenario: Weighted total from component scores
- **WHEN** 内容得分率为 0.5，三项比较得分均为 0.4
- **THEN** 单题总分为 46，并同时保留各分项及三个内容维度得分

#### Scenario: Missing comparison result
- **WHEN** 任一参考报告的比较在重试后仍无法得到有效结果
- **THEN** 该单元评分失败，不以剩余比较的平均值替代

### Requirement: DAComp upstream-compatible trajectory scoring

DAComp 适配器 SHALL 提供可选的上游兼容模式：对声明能交付统一格式轨迹的智能体，额外以该轨迹作为 rubric 评委输入计算一次内容得分及兼容总分，与主口径分开报告。不能提供统一轨迹的智能体启用该模式时 MUST 在预检被拒绝。

#### Scenario: Compatibility mode enabled
- **WHEN** 配置启用兼容模式且智能体交付统一轨迹
- **THEN** 报告同时含主口径与兼容口径，二者标注不同协议且不相互平均

#### Scenario: Agent lacks unified trajectory
- **WHEN** 兼容模式与未声明统一轨迹能力的智能体组合
- **THEN** 预检拒绝该组合

### Requirement: DSBench-Analysis task publication

DSBench-Analysis 适配器 SHALL 以每道题为一个任务，发布案例说明、该题题面及案例允许的数据文件，并记录所属案例作为分组键。参考答案、索引中的答案字段，以及可能含解答的 Notebook 或其他题目答案材料 MUST 不发布。

#### Scenario: Publish one question
- **WHEN** 选定案例 `00000032` 的 `question1`
- **THEN** 智能体获得说明、该题题面和案例工作簿，不获得答案或其他题目的答案

#### Scenario: Case without data files
- **WHEN** 选定题目所属案例只有说明和题面、没有数据文件
- **THEN** 任务以空输入清单发布并正常执行与评分，计入两项准确率分母

#### Scenario: Case directory contains a notebook
- **WHEN** 案例目录中含有 `.ipynb` 文件
- **THEN** 该文件不在发布清单中，并在适配器的排除记录中列出

### Requirement: DSBench-Analysis semantic judging

DSBench-Analysis 评分 SHALL 把题面、参考答案和智能体最终回答交给评委，使用上游语义一致判定 prompt 并按上游规则把输出解析为对或错。主汇总 SHALL 报告每题等权的题目准确率与案例平均准确率；执行失败或无回答的单元计为错误，评委失败为评分错误。

#### Scenario: Agent failed without an answer
- **WHEN** 某题智能体终止失败且无最终回答
- **THEN** 该题计为错误且无需评委调用，仍计入两项准确率分母

#### Scenario: Judge request raises an error
- **WHEN** 评委调用失败而上游实现会将其计为错误
- **THEN** 本项目记为评分错误并在协议偏离中说明该差异

### Requirement: Recorded upstream provenance and deviations

DAComp 与 DSBench-Analysis 的评分协议 SHALL 记录上游来源、版本与校验值、移植的 prompt 与解析逻辑、上游默认评委模型，以及本地偏离（评委模型、重试上限、失败处理、主/兼容口径、未复现的上游运行设置）。上游文件 MUST 保持原样。

#### Scenario: Report scoring protocol
- **WHEN** 用户查看 DAComp 批次的评分记录
- **THEN** 能看到上游评分代码版本、实际评委配置及与上游默认设置的全部偏离

### Requirement: Analysis benchmark development selections

系统 SHALL 为 DAComp-DA 与 DSBench-Analysis 各提供一份按公开信息（如任务编号、数据大小、文件类型）选择并在真实调用前冻结的小型开发清单及冒烟配置，标记开发用途。选择过程 MUST NOT 读取评分细则、参考报告或答案。

#### Scenario: Freeze DAComp development tasks
- **WHEN** 按数据库大小上限与编号规则生成 DAComp 开发清单
- **THEN** 清单记录任务身份、数据校验值与规则，不读取评分材料或调用模型
