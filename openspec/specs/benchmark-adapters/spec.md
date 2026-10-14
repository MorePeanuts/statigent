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

公共任务的输出契约 SHALL 声明输出类型及公开格式说明，支持文本回答、报告和预测文件。报告类型 MUST 指定报告文件名、允许的图片格式及数量与大小上限；预测类型 MUST 指定目标/指标协议、样本身份、输出列与形式、文件限额和阶段化输入规则。智能体未声明支持相应输出与阶段权限时，计划 MUST 在执行前被拒绝。

#### Scenario: Report task for a text-only agent
- **WHEN** DAComp 报告任务与只声明文本输出的智能体配置组合
- **THEN** 预检拒绝该组合并指出输出类型不兼容

#### Scenario: Prediction task for an analysis agent
- **WHEN** 建模预测任务与仅支持文本或报告的 EDA 适配器组合
- **THEN** 预检拒绝，不能把回答文本中的数字猜测为预测文件

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

### Requirement: 建模候选目录与独立审计状态

系统 SHALL 为 DSBench 已下载 52 项候选和 TabArena-Lite v0.1 的 51 项建立版本化目录，记录来源、目标、特征规则、预测形式、指标、外层划分、大小和协议问题。格式/资源可运行性、研究纳入资格及验收状态 SHALL 分开；未审计、阻塞和排除项不得消失。全候选审计与计划预检 MUST 不调用 LLM、不训练、不自动下载或修改上游数据。

#### Scenario: 全候选审计含特殊任务
- **WHEN** 下载候选含多目标或带未来预测语义的任务
- **THEN** 保留原候选身份，分别记录所需能力与研究划分疑问，不自动当作单目标 IID 任务或从清单删除

#### Scenario: 准备能力与验收状态不同
- **WHEN** 某任务通过静态审计但尚未运行任何模型
- **THEN** 显示预检通过、运行未验收，不称为完整适配验收通过

### Requirement: DSBench 建模任务发布与样本对齐

DSBench-Modeling SHALL 使用固定发布包的训练/测试划分、逐题目标和原始说明，另给出实际样本数、列和输出契约及可追溯勘误。系统 MUST 从特征中去除全部目标及训练独有不可用标签字段；稳定 ID 或冻结原行号用于样本对齐。测试特征仅在选择冻结后发布，私有标签、参考成绩和评分代码不得进入搜索或生成代码环境。

#### Scenario: 原题面样本数不适用
- **WHEN** 原 Kaggle 示例行数与 DSBench 发布测试数据不同
- **THEN** 实际发布样本清单决定交付行数，公开适配说明解释差异，原题面与原始数据不改写

#### Scenario: 多余训练标签字段
- **WHEN** s3e18 训练数据含 EC1 至 EC6，而预测目标为 EC1 和 EC2、测试特征不含其余 EC 列
- **THEN** EC1/EC2 作为目标，其余 EC 列不能混入拟合或 EDA 的可用预测特征；排除规则记录在任务协议

#### Scenario: 非唯一原始 ID
- **WHEN** 原数据没有可用唯一 ID
- **THEN** 准备端依据固定来源行序生成独立身份并保存映射，不把合成 ID 当作模型特征，也不按预测内容推断对齐

### Requirement: DSBench 评分来源与协议冲突

DSBench 适配器 SHALL 逐题绑定固定上游评分脚本、依赖版本、原生指标、预测导出规则及 baseline/GT 参考来源。主兼容口径以所固定发布评分实现为依据，题面与实现冲突、无效默认字段和样本对齐修正 SHALL 显式登记。未能确定含义或缺必需材料的任务 MUST 阻止执行；上游未定义边界返回明确评分失败，不静默修正或沿用原 Kaggle 指标。

#### Scenario: 指标变量名误导
- **WHEN** 上游变量名为 rmse 但实际调用 ROC AUC
- **THEN** 任务登记实际执行的 AUC 及方向，并记录命名冲突，不按变量名选择评分器

#### Scenario: 前三候选题面与代码不同
- **WHEN** 题面描述位置权重而固定脚本只计算前三命中
- **THEN** 主协议公开此偏离并使用已冻结的命中定义，内部搜索和确认一致；不同公式不得混入该主结果

### Requirement: DSBench RPG 与完成率

DSBench SHALL 保留逐任务原生指标，并按固定参考计算 max(0,(score-baseline)/(reference-baseline))，不截断超过一的结果。参考缺失、非有限、分母为零或方向冲突 MUST 明确阻塞相应评分。已执行终止且无有效预测的任务 RPG 计零；未运行、评分故障使完整汇总为空。完成率 SHALL 依据可评分预测计数，并与 Statigent 模型交付、复现和上游文件存在口径分别报告。

#### Scenario: 最小化指标与超过参考
- **WHEN** 任务使用 RMSE 且预测优于固定参考
- **THEN** 按相同公式得到可能大于一的 RPG，不改变方向或截断，说明参考不属于同条件重新训练基线

#### Scenario: 执行失败与评分材料损坏
- **WHEN** 一项执行失败无预测，另一项因 GT 文件损坏无法评分
- **THEN** 前者按固定分母计零，后者标为评分失败，完整 RPG 汇总为空，不都当零分也不删除任一项

### Requirement: TabArena 固定外层划分与数据解码

TabArena-Lite SHALL 固定 v0.1 数据版本和 r0f0 外层行索引，验证索引不重叠、无重复、完整覆盖且与原始行序一致。ARFF 和 Parquet 解码 SHALL 保留缺失、类别身份、特征类型及行映射，生成允许训练、延迟测试特征和私有标签。类别与正类只能依据允许训练和固定协议确定；预处理拟合与内部划分不得使用外层测试标签。

#### Scenario: 原始数据含全部标签
- **WHEN** 准备端读取 TabArena 原始数据
- **THEN** 原始目录不挂载到智能体；任务侧只能访问按阶段发布的数据，并可追溯到官方外层成员

#### Scenario: Parquet 与 ARFF
- **WHEN** 准备 APSFailure 的 Parquet 和其他任务的 ARFF
- **THEN** 两条路径都校验来源与精确行映射，不因文件格式替换外层划分或自动改变类别

### Requirement: TabArena system 协议与逐任务结果

TabArena 适配 SHALL 按固定官方 system 接口核验训练输入、指标、类别转换、资源、种子和预测语义，允许系统在外层训练内部管理验证和搜索，不再附加单模型 HPO。结果 SHALL 保留官方指标方向和本地原生值，注明本地 Lite 子集与官方管线兼容验证状态。当前开发汇总只做逐任务跨方法配对及完成率/成本，不平均不同尺度指标或宣称官方排行榜排名。

#### Scenario: 外层训练内确认
- **WHEN** 建模系统进行搜索与两份内部确认划分
- **THEN** 全部成员来自官方外层训练索引，测试标签不参与，确认结果不被当作外层独立测试

#### Scenario: 仅本地任务闭环通过
- **WHEN** 本地准备、预测和评分通过而官方 system 兼容用例尚未运行
- **THEN** 报告本地通过、官方兼容未验收，不冒称官方管线已接入

### Requirement: 建模开发清单与分层验收

两套基准 SHALL 各有按公开规模、任务类型和协议覆盖选择的小型开发清单及明确资源配置，包含普通回归/分类和特殊预测形式的覆盖安排。验收 SHALL 分列全候选审计、无 LLM 确定性模型链路、真实模型用例和正式实验；资源受限或未执行项保留。真实运行需显式任务/方法/预算，不能用开发结果筛选正式任务或自动补跑失败。

#### Scenario: 指标验证不需要付费
- **WHEN** 全指标合成差分测试和真实数据预检完成
- **THEN** 报告这两层证据，不声称全部候选已完成真实智能体训练

#### Scenario: 数据来源重叠
- **WHEN** 两套基准或既有开发任务存在同源数据
- **THEN** 清单记录已知重叠与开发暴露，正式选择可据此处理，不能将其自动视为独立泛化证据
