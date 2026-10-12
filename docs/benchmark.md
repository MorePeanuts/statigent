# 两个核心章节使用的 Benchmark

## 最终选择

| 章节 | Benchmark | 规模 | 用来评价什么 |
| --- | --- | --- | --- |
| 探索性数据分析 | **DAComp-DA（主）** | 100 个开放式分析任务 | 能否围绕业务问题展开分析，得出正确、有证据的结论 |
| 探索性数据分析 | **DSBench-Analysis（辅）** | 38 个竞赛案例、466 道题 | 能否理解复杂业务背景，结合多表数据完成分析并答对问题 |
| 探索性数据分析 | **InfiAgent-DABench（辅）** | 257 道题，52 份 CSV | 统计计算、数据处理和分析答案是否正确 |
| 预测性建模 | **DSBench-Modeling 表格子集（主）** | 官方 74 项；当前下载 52 项表格任务 | 能否自主完成建模，并对未见样本作出有效预测 |
| 预测性建模 | **TabArena-Lite（主）** | 初始版本 51 个表格数据集，每个使用一个固定测试划分 | 在统一条件下比较预测效果、稳定性和成本 |

第二章已确定 DSBench-Modeling 与 TabArena-Lite 两套主基准，前者检验完整自主建模流程，后者检验受控表格预测与预算效率。按“API + 少量 GPU”的资源条件，先在少量开发任务上测量成本，再开展正式实验。**TabArena 本身没有智能体任务提示，需要我们把现有预测任务接成 agent 的输入输出接口。** 两章的关联实验直接使用第二章数据，比较建模智能体独立运行与按需调用探索智能体的效果。

**章节划分的文献依据：** [DSBench](https://arxiv.org/abs/2409.07703) 将数据分析与预测建模分别定义、分别评测：前者理解已有数据并回答问题，后者训练模型并预测未见样本。这支持本课题将两类任务设为独立核心章节。其 Analysis 来自 ModelOff，Modeling 来自 Kaggle，二者不是配对数据；两章的递进关系仍通过“建模智能体按需调用探索智能体”的关联实验验证。第一章中，DAComp-DA 评价开放式分析质量，DSBench-Analysis 评价复杂案例解题能力，InfiAgent-DABench 补充标准答案的计算正确性。

下面每个示例都取自官方数据，大表在正文只展示一行预览。数据统一存放于项目根目录的 [benchmarks](../benchmarks/README.md)，原临时样本目录已移除，示例链接改为正式数据路径。数据下载与评测环境接入是两个步骤；当前尚未运行智能体、模型训练或完整评测。评分演算中的假设数字会单独标明。

## 第一章：探索性数据分析

本章检验“持续 Notebook 内核 + 规划/执行分离”是否改善分析质量与成本。主实验对比纯 LLM、基础 ReAct 和已有数据分析智能体；消融分别合并规划者与执行者、移除持续内核。移除内核指每次从头生成完整 Python 脚本并在新进程执行，不保留变量或对象，不能用磁盘缓存变相恢复状态。统计所有角色及重试的输入/输出 token、API 费用、执行时间和总耗时；评分裁判的费用单独记账。

### 1. DAComp-DA：开放式业务分析

**是什么：** 给智能体一份数据库和一个业务问题，让它自行选择分析步骤，输出结论、计算证据和图表。这里使用分析子集，不使用数据工程子集。

| 基本信息 | 内容 |
| --- | --- |
| 数据集规模 | **100 个分析任务**；论文统计每个任务平均约 **3.9 张表、84.7 列**。各任务行数不同，下方真实样本为 42,816 行、16 列。 |
| 所属行业 / 领域 | 跨行业业务分析，例如零售销售、金融信贷、物流、制造业及人力资源管理。 |
| 数据集类型 | **结构化数据库 + 开放式自然语言问题**。输入为 SQLite 数据库，包含数值、类别、日期等字段；参考评分材料为任务专属评分细则，产出为分析结论、计算证据和图表。 |

**真实样本：`dacomp-002`**

以下是官方任务记录的全部字段：

```json
{
  "instance_id": "dacomp-002",
  "instruction": "Please analyze the growth trend of Sales Amount for each Major Category from January to April. How have customers’ purchasing preferences changed? How should product categories and inventory be adjusted for May–August?"
}
```

中文直译：请分析 1—4 月各大类销售金额的增长趋势。顾客的购买偏好发生了怎样的变化？5—8 月应如何调整商品品类和库存？

输入为 `dacomp-002.sqlite`，其中 `sheet1` 有 **42,816 行、16 列**。第一条原始记录如下，字段和值均来自数据库：

```json
{
  "Customer ID": 0,
  "Major Category Code": 12,
  "Major Category Name": "Vegetables and fruits",
  "Intermediate Category Code": 1201,
  "Intermediate Category Name": "Vegetables",
  "Minor Category Code": 120109,
  "Minor Category Name": "Other vegetables",
  "Sales Date": 20150101,
  "Sales Month": 201501,
  "Product Code": "DW-1201090311",
  "Specification/Model": "Unknown",
  "Product Type": "Fresh food",
  "Unit": "piece",
  "Sales Quantity": 8,
  "Sales Amount": 4.0,
  "Is Promotional": "Regular Price"
}
```

它没有唯一的文字答案，而有逐项评分标准。这个样本的官方内容评分满分为 **22 分**：销售趋势 10 分、购买偏好变化 8 分、品类与库存建议 4 分。例如，需要覆盖全部 15 个大类、算对月销售额和环比，并让建议与分析结果相符。

**怎样算分：**

| 组成 | 具体评什么、怎么算 |
| --- | --- |
| 内容得分，权重 60% | 裁判对照每题的评分清单检查完整性、数值正确性、结论是否有依据。`R = 实得分 ÷ 该题满分`。本题拿到 11 / 22 分，则 R = 0.5 |
| 可读性，权重 10% | 与官方 5 份参考报告分别比较，判断更好、相当、更差。`G = max(更好次数 − 更差次数, 0) ÷ 比较次数` |
| 分析专业性，权重 10% | 同上，比较分析深度、论证等，计算独立的 G |
| 可视化，权重 20% | 同上，比较图表表达与分析支持作用，计算独立的 G |

每题总分为 `100 × (0.6R + 0.1G可读性 + 0.1G专业性 + 0.2G可视化)`，再对任务取平均，越高越好。**演算示例：** 假设内容得分 11 / 22，后三项都为“3 次更好、1 次相当、1 次更差”，各 G = 0.4，则总分为 **46 分**。这不是本次运行结果。

这是“按细则评价分析质量”，不是对文字答案做完全匹配；需要额外的裁判 API 调用。

[本地任务数据库](../benchmarks/dacomp-da/public/dacomp-002/dacomp-002.sqlite) · [原始任务集合](https://huggingface.co/datasets/DAComp/dacomp-da/blob/main/dacomp-da.jsonl) · [该题完整评分材料](https://github.com/ByteDance-Seed/DAComp/tree/main/dacomp-da/evaluation_suite/src/dacomp-002) · [官方计分代码](https://github.com/ByteDance-Seed/DAComp/blob/main/dacomp-da/evaluation_suite/core/rubric_scoring.py)

论文：Fangyu Lei 等，[*DAComp: Benchmarking Data Agents across the Full Data Intelligence Lifecycle*](https://arxiv.org/abs/2512.04324)，2025 年发布，ICLR 2026。

### 2. InfiAgent-DABench：有标准答案的数据分析

**是什么：** 输入 CSV 和明确问题，输出指定格式的答案。包含统计、数据处理、特征分析，也有按要求执行指定模型的题目。我们用它检查分析结果的客观正确性。

| 基本信息 | 内容 |
| --- | --- |
| 数据集规模 | 公开集共 **257 道题、52 份 CSV**，一份数据可对应多道题；各表行数不同，下方真实样本的 CSV 有 715 行。 |
| 所属行业 / 领域 | 论文分为 **9 类**：金融与经济、健康医疗、人口与社会科学、营销与消费者行为、能源与环境、交通物流与旅游、文化娱乐与媒体、科研与技术，以及其他类别。 |
| 数据集类型 | **结构化 CSV 表格 + 有标准答案的分析问答**。每题包含问题、数据文件名、作答约束和格式要求，另有参考答案；主要评价计算与分析结果是否正确。 |

**真实样本：`id = 6`**

以下是官方问题记录的全部字段：

```json
{
  "id": 6,
  "question": "Create a new column called \"AgeGroup\" that categorizes the passengers into four age groups: 'Child' (0-12 years old), 'Teenager' (13-19 years old), 'Adult' (20-59 years old), and 'Elderly' (60 years old and above). Then, calculate the mean fare for each age group.",
  "concepts": [
    "Feature Engineering",
    "Summary Statistics"
  ],
  "constraints": "Make sure to round the mean fare of each group to 2 decimal places.",
  "format": "@mean_fare_child[mean_fare], @mean_fare_teenager[mean_fare], @mean_fare_adult[mean_fare], @mean_fare_elderly[mean_fare], where \"mean_fare\" is a float number rounded to 2 decimal places.",
  "file_name": "test_ave.csv",
  "level": "medium"
}
```

中文直译：建立年龄组列，把乘客分为儿童（0—12 岁）、青少年（13—19 岁）、成年人（20—59 岁）和老年人（60 岁及以上），计算每组平均票价，保留两位小数。

输入 `test_ave.csv` 有 **715 行**。第一条完整数据记录为：

```csv
,PassengerId,Survived,Pclass,Name,Sex,Age,SibSp,Parch,Ticket,Fare,Cabin,Embarked,AgeBand
0,1,0,3,"Braund, Mr. Owen Harris",male,22.0,1,0,A/5 21171,7.25,,S,2
```

官方标准答案记录：

```json
{
  "id": 6,
  "common_answers": [
    [
      "mean_fare_elderly",
      "43.47"
    ],
    [
      "mean_fare_teenager",
      "31.98"
    ],
    [
      "mean_fare_child",
      "31.09"
    ],
    [
      "mean_fare_adult",
      "35.17"
    ]
  ]
}
```

**怎样算分：** 先从 `@字段名[数值]` 中提取答案，逐项与标准答案比较。该题四个均值**全部正确才算整题答对**；只答对三个，整题记 0。整体准确率为 `答对的题数 ÷ 评测题数 × 100%`，越高越好；也可单独报告子问题准确率，解释部分完成情况。当前评分器对数值的相等判定允许小于 `10⁻⁶` 的差异，因此应先按题目要求四舍五入。

例如，答案全部写对是 1 道正确题，不是 4 道正确题。正式实验将无输出和失败也计入分母，避免遗漏失败任务虚增准确率。

统一评测层的接入与使用见 [评测说明](evaluation.md)。其主汇总逐题等权报告 ABQ 和 PSAQ，失败计零；预算停止导致的未运行和评分系统错误标记为不完整，完整批次得分为空。上游兼容结果另列非空回答分母及覆盖率。数据下载、软件接入验证和真实实验结果分别记录，不以合成测试成绩代替基准结果。

[本地问题与数据](../benchmarks/infiagent-dabench/public) · [官方问题](https://github.com/InfiAgent/InfiAgent/blob/main/examples/DA-Agent/data/da-dev-questions.jsonl) · [官方答案](https://github.com/InfiAgent/InfiAgent/blob/main/examples/DA-Agent/data/da-dev-labels.jsonl) · [评分代码](https://github.com/InfiAgent/InfiAgent/blob/main/examples/DA-Agent/eval_closed_form.py)

论文：Xueyu Hu 等，[*InfiAgent-DABench: Evaluating Agents on Data Analysis Tasks*](https://arxiv.org/abs/2401.05507)，ICML 2024。这里的 257 题是公开 validation 集，不是隐藏测试集。

### 3. DSBench-Analysis：复杂业务案例分析

**是什么：** 读取案例背景、数据文件和具体问题，完成数据整理、计算与推理，给出选择题或填空题答案。用于补充第一章对复杂业务分析的评测，与第二章的 DSBench-Modeling 共同覆盖该基准的两类任务。

| 基本信息 | 内容 |
| --- | --- |
| 数据集规模 | **38 个 ModelOff 竞赛案例、466 道题**，每个案例 3–50 题。论文统计共 **31 个 Excel 文件、69 个工作表、5 张图片**，Excel 总大小约 7.3 MB；部分题目不带外部数据文件。 |
| 所属行业 / 领域 | 以**金融与商业分析**为主，包括融资、投资、现金流、税务等，也有能源用量、运营与通用数据处理案例。 |
| 数据集类型 | **Excel 工作簿 + 案例说明 + 选择 / 填空问答及标准答案**；说明可能包含表格和图片，工作簿可含多个工作表。不是训练集 / 测试集形式的机器学习预测任务。 |

**真实样本：`00000032 / question1`，2014 Round 1 — Dealing With Data**

该题的完整输入由案例背景、工作簿和问题组成；以下问题原文直接取自官方 `question1.txt`：

```text
Question 1 What is your average hourly electricity usage?  a. 0.641kWh b. 0.782kWh c. 0.884kWh d. 0.937kWh
```

中文直译：你的平均每小时用电量是多少？官方答案为 **B，即 0.782 kWh**。

| 样本组成 | 原始材料 |
| --- | --- |
| 完整背景 | [introduction.txt 原文](../benchmarks/dsbench/analysis/public/00000032/introduction.txt)，包含电表记录说明、三种合同及数据清洗要求 |
| 完整数据 | `MO14-Round-1-Dealing-With-Data-Workbook.xlsx`（151,402 字节），包含 `Usage` 用电历史与 `Contracts` 合同信息；原文件保存在下方本地案例目录中 |
| 题目与答案 | 本地案例目录保留全部 7 道原始问题；官方含答案索引保存在 `dsbench/analysis/private/tasks-with-answers.jsonl`，供查看和评分 |

**怎样算分：** 官方评分器把问题、标准答案和智能体答案交给 LLM 判断是否语义一致，每题记 1 或 0；原实现使用 `gpt-4o-2024-05-13`，不是纯字符串匹配，因此要计入裁判 API 成本。

| 指标 | 含义与计算 |
| --- | --- |
| 题目准确率 | `答对题数 ÷ 466 × 100%`，每题权重相同；无输出或失败计为错误。例如假设答对 233 题，准确率为 50% |
| 案例平均准确率 | 先算每个案例的 `答对题数 ÷ 该案例题数`，再对 38 个案例取平均，让每个案例权重相同，避免题量大的案例主导结果 |

两项均越高越好。**演算示例：** 假设只评测两个案例，分别答对 2/3 题和 1/7 题，题目准确率为 3/10 = **30%**，案例平均准确率为 `(2/3 + 1/7) ÷ 2 ≈ 40.48%`。这是解释权重差异的假设数字，不是实验结果。

**使用定位：** 全量成绩保留与已有研究的可比性；其中也有 Excel 知识、财务计算和逻辑题，不能把全部 466 题等同于开放式 EDA。Notebook 证据与可复现性仍需本课题另外检查，原生准确率只评价最终答案。

[本地完整案例](../benchmarks/dsbench/analysis/public/00000032) · [官方案例索引](https://github.com/LiqiangJing/DSBench/blob/main/data_analysis/data.json) · [官方数据包](https://huggingface.co/datasets/liqiang888/DSBench/blob/main/data_analysis/data.zip) · [答案判定代码](https://github.com/LiqiangJing/DSBench/blob/main/data_analysis/compute_answer.py) · [准确率汇总代码](https://github.com/LiqiangJing/DSBench/blob/main/data_analysis/show_result.py)

论文：Liqiang Jing 等，[*DSBench: How Far Are Data Science Agents from Becoming Data Science Experts?*](https://arxiv.org/abs/2409.07703)，2024 年首次发布，ICLR 2025。分析任务定义见 §2.1，规模统计见 Table 2。

## 第二章：预测性建模

本章检验“预算约束下，诊断驱动的自主机器学习实验”：建模智能体提出候选改进及待验证问题，按需调用第一章的探索智能体，根据返回证据调整训练优先级，再通过真实验证结果判断改进是否成立。两个主基准分别覆盖端到端任务交付和受控表格预测，不预设 EDA 必然提升成绩。

主对比包括同预算传统 AutoML、通用建模智能体及代表性研究方法；核心消融为不调用 EDA、仅开始时调用一次 EDA、可动态调用但无明确决策关联、完整方法。固定底层 LLM、硬件和总预算，把 EDA、训练、重试全部计入成本。测试标签仅供最终评分，分析和自适应试验都基于训练部分及其内部验证划分。报告逐任务原生分数、成功率、预算—效果曲线、token/API 成本、训练与总耗时，不直接平均不同尺度的原生指标。

### 4. DSBench-Modeling：从任务说明到预测结果

**是什么：** 智能体读取 Kaggle 任务说明和训练数据，自主处理特征、选择模型、训练与迭代，最后输出测试集预测。原生指标随任务变化，例如分类准确率、AUC、RMSE。

| 基本信息 | 内容 |
| --- | --- |
| 数据集规模 | **74 个建模任务**，各任务数据量不同；下方 Titanic 样本为 **712 条训练记录、179 条测试记录**。这里不包含 DSBench 的 466 道分析题。 |
| 所属行业 / 领域 | 跨行业，包括金融与保险、零售、交通、医疗与公共卫生、教育等。 |
| 数据集类型 | **监督学习数据 + 竞赛任务说明**。提供训练集、测试集及评测端独立保存的测试标签，主要以 CSV 承载；除数值和类别特征，也涉及文本、时间序列。任务包括分类、回归等，产出为预测文件。 |

**真实样本：`titanic`**

官方任务索引中的完整记录：

```json
{
  "name": "titanic",
  "url": "https://www.kaggle.com/competitions/titanic",
  "size": "93.08 kB",
  "year": 2012
}
```

任务原文中的目标：

> The competition is simple: use machine learning to create a model that predicts which passengers survived the Titanic shipwreck.

这条索引不是完整题面；完整的原始题面，包括任务描述、评测方式、字段字典，保留在 [task.txt](../benchmarks/dsbench/modeling/public/titanic/task.txt)，没有改写。实际输入及评分文件从 DSBench 发布的压缩包中抽取如下：

| 文件 | 实际规模 | 用途 |
| --- | --- | --- |
| `train.csv` | 712 行、12 列 | 训练数据，含目标 `Survived` |
| `test.csv` | 179 行、11 列 | 智能体需要预测的乘客，不含目标 |
| `test_answer.csv` | 179 行、2 列 | 仅供评测端使用的真实标签 |
| `gender_submission.csv`（未下载） | 上游为 418 行、2 列 | 原 Kaggle 提交示例与当前测试集不匹配，选择性下载时跳过 |

**一条完整测试输入及其官方标签**（测试文件第 1 行）：

```csv
PassengerId,Pclass,Name,Sex,Age,SibSp,Parch,Ticket,Fare,Cabin,Embarked
710,3,"Moubarek, Master. Halim Gonios (""William George"")",male,,1,1,2661,15.2458,,C
```

```csv
PassengerId,Survived
710,1
```

智能体应预测 `Survived`，最终交付覆盖 **179 名乘客**的预测文件。标签表只用于说明和评测，不能作为智能体输入。原始题面仍写着 Kaggle 的 418 行要求，实际跑 DSBench 时应以其重划分数据为准。

**怎样算分：**

| 指标 | 含义与计算 |
| --- | --- |
| 任务成功率 | `成功完成建模并生成可评分预测的任务数 ÷ 总任务数`。它只说明流程完成了，不代表预测准确 |
| 任务原生分数 | Titanic 使用 `预测正确的乘客数 ÷ 179`。例如答对 143 人，准确率约 79.89%；其他任务使用各自指标，不能直接混在一起平均 |
| RPG：跨任务归一化得分 | 每题计算 `max((智能体分数 − 基线分数) ÷ (人类参考分数 − 基线分数), 0)`，然后对全部任务取平均。它衡量从简单基线到人类参考水平之间的差距，智能体填补了多少 |

**RPG 演算示例：** 假设某分类任务基线 60%、人类参考 90%、智能体 75%，则该题 RPG = `(0.75−0.60)/(0.90−0.60) = 0.5`，表示填补了一半差距。尽管名称含“Gap”，这个分数是**越高越好**。人类参考来自原竞赛榜单，而本地测试集重新划分过，因此只把它当归一化参考，不据此声称严格超过同条件人类。

[本地 Titanic 任务](../benchmarks/dsbench/modeling/public/titanic) · [官方数据包](https://huggingface.co/datasets/liqiang888/DSBench/blob/main/data_modeling/data.zip) · [Titanic 评分代码](https://github.com/LiqiangJing/DSBench/blob/main/data_modeling/evaluation/titanic_eval.py) · [RPG 汇总代码](https://github.com/LiqiangJing/DSBench/blob/main/data_modeling/show_result.py)

论文：Liqiang Jing 等，[*DSBench: How Far Are Data Science Agents from Becoming Data Science Experts?*](https://arxiv.org/abs/2409.07703)，ICLR 2025。第二章使用其表格建模子集，466 道分析题用于第一章，两部分分别评分。不能将子集结果标为完整 74 项结果。

### 5. TabArena-Lite：统一条件下的表格预测

**是什么：** 在固定训练 / 测试划分下评价表格预测能力。它已有数据、目标列、划分和评分规则，但没有自然语言 agent 题面，需要我们补充任务接口。

| 基本信息 | 内容 |
| --- | --- |
| 数据集规模 | 固定初始版本的 **51 个数据集：30 个二分类、8 个多分类、13 个回归**。按官方 v0.1 元数据，每个数据集有 **748–150,000 条记录、4–1,776 个特征**；Lite 每个数据集只用一个官方外层划分，不缩减数据集数量。 |
| 所属行业 / 领域 | 覆盖 **10 类领域**：商业营销、金融、医疗健康、生物生命科学、物理天文、化学材料、科技互联网、工业制造、环境气候、教育。 |
| 数据集类型 | **结构化表格监督学习数据**，包含数值、类别等输入特征及明确的目标列，部分有缺失值；使用官方划分和评分规则完成二分类、多分类或回归。 |

**真实样本：`Bank_Customer_Churn`，OpenML task `363619`**

| 官方任务字段 | 值 |
| --- | --- |
| 数据集 | `Bank_Customer_Churn`，OpenML dataset `46911`，版本 1 |
| 领域 / 任务 | 银行客户流失预测 / 二分类 |
| 规模 | 10,000 名客户，10 个输入特征，目标列 `churn` |
| 标签 | `No` / `Yes` |
| TabArena 指标 | `roc_auc` |
| 本例使用的官方划分 | `repeat=0, fold=0`：6,666 条训练、3,334 条测试 |

数据文件第 1 行的全部特征与标签如下，直接摘自官方 ARFF：

```csv
credit_score,country,gender,age,tenure,balance,products_number,credit_card,active_member,estimated_salary,churn
596,Germany,Male,32,3,96709.07,2,0,0,41788.37,No
```

任务要求模型利用前 10 列，预测新客户是否流失；为计算 AUC，应输出流失概率。本地目录保存完整 OpenML 任务定义、数据定义、10,000 行原始 ARFF 数据，以及 Lite 所需的 **repeat=0、fold=0** 划分索引；其余外层重复划分不保留。原始 ARFF 含全部标签，必须由评测端按索引划分，禁止直接向智能体开放整个原始文件。

**怎样算分：**

| 任务类型 / 指标 | 评什么、怎么算 |
| --- | --- |
| 二分类：ROC AUC，越高越好 | 从正例和负例各抽一个，看模型是否把正例排得更高。`AUC = (正确排序的正负样本对数 + 0.5 × 同分对数) ÷ 全部正负样本对数`。本例正例是 `Yes`。AUC=1 为完全排对，0.5 约相当于随机排序 |
| 多分类：log-loss，越低越好 | 检查模型给真实类别分配了多少概率：`−平均值[ln(真实类别的预测概率)]`。真实类别概率为 0.9 时单条损失约 0.105；只有 0.1 时损失约 2.303，说明自信地预测错会受较大惩罚 |
| 回归：RMSE，越低越好 | `√平均值[(预测值−真实值)²]`，单位与预测目标相同。假设两条预测误差是 +2 和 −2，RMSE 就是 2 |

本课题优先报告各任务原生分数和同任务上的方法胜率，不把 AUC、log-loss、RMSE 直接平均。官方还提供 Elo 聚合排名，但它依赖参与比较的方法集合，不把它作为理解本课题效果的唯一数字。

[本地 OpenML 任务与数据](../benchmarks/tabarena-lite/raw/363619) · [官方任务定义](https://www.openml.org/api/v1/json/task/363619) · [数据定义](https://www.openml.org/api/v1/json/data/46911) · [TabArena 任务元数据](https://github.com/autogluon/tabarena/blob/main/packages/tabarena/src/tabarena/benchmark/task/metadata/sources/data/TabArena-v0.1_tasks_metadata.csv)

论文：Nick Erickson 等，[*TabArena: A Living Benchmark for Machine Learning on Tabular Data*](https://arxiv.org/abs/2506.16791)，NeurIPS 2025 Datasets and Benchmarks。实验固定初始 51 数据集版本，不随持续更新的榜单改变任务集合。

**接入方式：** 把本方法作为自行管理预处理、内部验证、搜索和集成的 `system` 接入，不在完整智能体外再套单模型的 200 配置 HPO。保留官方外层划分。官方排行榜所用预算与硬件可能不同，应重跑同条件基线后再比较成本；Lite 减少的是外层划分数量，不保证全部训练便宜。[官方 system 接入示例](https://github.com/autogluon/tabarena/blob/main/examples/benchmarking/run_quickstart_tabarena_system.py)

### 下载范围与实验清单的区别

DSBench 官方索引有 74 项，当前下载其中 **52 项常规结构化表格任务**，排除 22 项文本、时序/信号、未来预测或特殊结构任务。具体清单及理由见 [ds-modeling-selection.json](../benchmarks/metadata/ds-modeling-selection.json)。发布压缩包还多出索引之外的 `tabular-playground-series-oct-2021`，本次不自动纳入。每项只提取任务说明、处理后的训练/测试 CSV 和评测端标签，不下载原 Kaggle 提交模板及 macOS 隐藏文件。

这是按任务类型确定的下载候选集，**尚未证明 52 项都适合低成本训练**；例如部分任务仍是大表。先在独立开发任务上测量资源，再按事先公开的资源规则冻结正式集合，不按本方法测试分数挑题。任何减少任务数的实验必须明确标为子集。TabArena 的 51 项也遵循同样原则。其中 APSFailure 使用 OpenML 元数据提供的同版本官方 Parquet 文件，以支持分块重试；其余任务保留 ARFF。文件格式调整不改变任务、标签或官方外层划分。

文件布局、实际下载状态与复现命令统一记录在 [benchmarks/README.md](../benchmarks/README.md)。`private`、`evaluator` 和含全量标签的 `raw` 目录只能供数据准备/评测端访问；目录名本身不是权限隔离，运行环境仍需单独挂载允许给智能体的输入。

## 补充资料：本轮不选入的 Benchmark

这里只保留以后可能用到的索引，不增加当前必跑清单。

| Benchmark / 论文 | 规模与内容 | 暂不采用的原因 / 后续用途 |
| --- | --- | --- |
| [InsightEval](https://aclanthology.org/2026.findings-acl.1729/) | 100 场景、1,000 条参考洞察；业务表格自主发现，2026 | 若重点转向“自主提出问题与洞察发现”，优先补充；仍依赖裁判 |
| [InsightBench](https://arxiv.org/abs/2407.06423) | 100 合成业务数据集、475 条洞察；配参考 Notebook，2024/2025 | 经典对照；InsightEval 对其标注做了修订，二者同源，不能当独立泛化证据 |
| [DDR-Bench](https://arxiv.org/abs/2602.02039) | 291 个实体、2,058 条事实；医疗、行为、财务自主探索，2026 | 无具体问题的探索扩展；优先公开的 10-K 子集（100 公司），全量有访问与成本门槛 |
| [DABstep](https://arxiv.org/abs/2506.23719) | 450 道支付业务多步分析题，2025 | 完整测试答案隐藏，公开 dev 仅 10 题；适合最终外部测试 |
| [DSAEval](https://arxiv.org/abs/2601.13591) | 641 问题、285 数据集；多轮 Notebook，2026 | 混合 EDA、建模和深度学习；使用前需筛出完整分析会话 |
| [DataSciBench](https://aclanthology.org/2026.findings-acl.181/) | 222 prompts、519 检查项；数据科学复合任务，2025/2026 | 可检查代码产物，但混有建模与深度学习，暂不重复扩张任务范围 |
| [DA-Code](https://arxiv.org/abs/2410.07331) | 500 个整理、EDA、ML 任务，2024 | 偏可执行代码与文件产物，可作工具能力补充 |
| [LongDA](https://arxiv.org/abs/2601.02598) | 17 个美国调查、505 查询，2026 | 重点是长文档、变量手册与统计口径理解，API 上下文成本较高 |
| [KramaBench](https://arxiv.org/abs/2506.06541) | 104 挑战、约 1,700 文件；跨 6 领域数据湖，2025 | 数据发现和整合因素较重，适合异构数据专项扩展 |
| [AgenticDataBench](https://arxiv.org/abs/2607.01647) | 344 任务、15 领域；异构业务工作流，2026 | 官方保留 98 个私有测试任务；分析与建模混合 |
| [DataSpace](https://arxiv.org/abs/2608.03451) | 410 任务、7,439 文件；表格、文档、视频，2026 | 重点是跨格式证据整合与完整结果表，可作后续客观测试 |
| [Data Agent Benchmark](https://arxiv.org/abs/2603.20576) | 54 查询、12 数据集、4 类数据库，2026 | 偏跨系统集成查询，部署成本较高 |
| [SELA 评测集](https://arxiv.org/abs/2410.17238) | 20 数据集：13 分类、7 回归，2024 | 可作低成本先导，但与其他表格任务重合，暂不另加一套 |
| [MLAgentBench](https://arxiv.org/abs/2310.03302) | 13 个跨模态机器学习实验，2023/2024 | 经典但样本少，部分任务训练较重 |
| [MLE-Dojo](https://arxiv.org/abs/2505.07782) | 200+ 任务；实验 train/eval=150/50，2025 | 与 DSBench 等竞赛任务集大量重合，更适合环境复用或 agent 训练 |
| [MLGym](https://arxiv.org/abs/2502.14499) | 13 个 ML、强化学习与博弈任务，2025 | 范围超过当前预测建模目标 |
| [IDA-Bench](https://arxiv.org/abs/2505.18223) | 25 个交互任务、209 条参考洞察，2025 | 主要是模拟用户指导的预测建模，不是自主 EDA；另有用户模拟成本 |
| [AIRS-Bench](https://arxiv.org/abs/2602.06855) | 20 个前沿机器学习研究任务，2026 | 自主研究与实现负担较大，超出默认预算 |
| [DeltaML-Bench](https://arxiv.org/abs/2608.19653) | 48 个研究仓库改进任务，2026 | 重 GPU 与长时实验，适合更广义的研究 agent |
| [ResearchGym](https://arxiv.org/abs/2602.15112) | 5 个研究环境、39 子任务，2026 | 偏提出并验证研究改进，不作为当前建模主实验 |

实验方案与下载清单更新日期：2026-10-10。未重新核查补充索引中全部未选基准。下载来源、固定版本和文件校验值见 [benchmarks/metadata](../benchmarks/metadata)；本次未调用模型运行 benchmark。
