# Spec Delta

## ADDED Requirements

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
