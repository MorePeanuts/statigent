# 建模智能体

支持单目标表格回归、二分类与多分类，复用候选管理、定向双角色 EDA、预算、隔离执行与交付链路。支持矩阵见下文；不含多标签、阈值搜索、概率校准或 Benchmark 适配。

## 研究方向与当前实现

第二章采用“分析与建模协同驱动的自主机器学习方法”，以独立测试预测效果为主，同时关注可靠性与实际效率。三项核心机制、研究假设和消融以 [研究大纲](overview.md#第二核心章节面向预测性数据建模的智能体研究) 为准，评价口径见 [Benchmark 协议](benchmark.md#第二章预测性建模)。预算管理在研究中承担运行保护与公平控制的作用。

新版实现包含任务内认识、自主分析交接、终局确认及四种方法权限。任务 schema 2、模型侧接口 modeling-decision-v1、内部动作协议 3、提示词 modeling-v6、父记录与交付 schema 3 配套使用。固定原始数据与搜索划分继续保留。软件检查、真实模型验收和研究效果分别报告，见 [本轮开发验收](modeling-collaboration-validation.md)。

当前默认一次 EDA、三次搜索拟合和一次最终拟合用于开发验证，不代表正式实验的协同深度或资源条件。历史验收记录保留其当时配置与结论；功能链路通过不等于上述方法具有稳定的预测收益。

## 新任务配置与基础概览

新启动配置要求 `schema_version: 2`、`method`、`confirmation: {"mode": "none" | "terminal_repeated_holdout"}` 和 `resource_version`。四组共享基础概览、候选管理、训练、确认和交付能力：

| method | 分析与认识机制 |
| --- | --- |
| no_eda | 无 EDA 工具 |
| initial_eda | 首次模型决策前由宿主固定委派一次任务相关 EDA；已知失败可继续建模，不自动重做 |
| adaptive_eda | 智能体按需调用 EDA，保留普通动作与结果历史 |
| collaborative | 按需 EDA 加显式认识修订、来源和跨轮上下文 |

普通三组不接收认识更新字段；no_eda/initial_eda 的模型无法通过伪造 analyze 调用越权。未使用 EDA 不产生虚拟消费。

仓库原任务示例迁移为 `adaptive_eda`、关闭确认、资源版本 `smoke-v1`，保留原有全部显式额度。旧任务直接启动会提示迁移；历史交付使用独立冻结配置解析器，不补造新方法身份。确认模式 `terminal_repeated_holdout` 的预检要求额外预留最多四次确认及最终拟合/预测，现有小额示例不能直接开启。

每次新运行在首个模型请求前，经 `uv` 调用可信固定概览程序，仅物化内部训练成员。所有方法获得同一份字段角色、缺失量、唯一值数、数值分位数、类别频数和目标概要；不计算特征关联、推荐或误差诊断。空字符串是缺失，其他原始字符串保留；分类目标即使形如 `001` 也按标签处理。数值仅接受有限十进制（含指数），解析失败数量另列。

概览最多 128 列，每列最多 10 个类别频数，类别值最多显示 128 个字符，明确记录省略类别和字符数；超出列数或 256 字符列名限制则拒绝准备。产物位于 `basic-profile/`，绑定训练文件、训练成员、划分、任务协议及生成器版本，保存内容哈希。准备耗时计入父墙钟并单列 `preparation.profile_elapsed_ms`，不再与父墙钟相加；失败保留诊断且不进入模型搜索。

## 准备数据

输入为一个带目标的训练 CSV 和一个不含目标的预测 CSV，必须有不重叠的唯一稳定 ID、相同特征；回归目标为有限数值，分类目标为原始非空字符串。ID 不作为训练特征。准备过程不读取测试标签、不调用模型、不修改源数据。

```sh
bun run modeling prepare --config configs/modeling/synthetic-prepare.json --out runs/modeling-synthetic-data
```

输出目录必须尚不存在，父目录必须存在。生成只读 train.csv/test.csv 和 dataset.json，后者保存文件哈希、目标、种子、指标方向及精确内部划分。回归默认按 seed 与行 ID 哈希排序生成 80/20 留出，分类按类别分层生成；可显式给出完整且不相交的 split.train/split.validation ID 清单。搜索不能重新划分。

源配置使用 input_root/train/test/target/id_column/kind/metric/seed；类型/指标按下方支持矩阵校验；二分类另需 positive_class。原始数据和准备产物不提交 Git。每次加载校验哈希、列结构和划分成员，输入变化须重新准备并保留新版本。

## 认识状态与原子决策 v3

完整协同模式可随任一动作提交 `knowledge_updates` 和 `knowledge_refs`，没有变化时可以省略；普通模式不提供这两个字段。模型只需给出认识的 `id/kind/statement/reason`，同 ID 表示更新当前认识。宿主填入内部 `create/revise` 及准确基版本，保存新旧修订、任务作用域和接受序号。状态可省略：新 observation 默认 active，新 hypothesis/question 默认 open；修订默认保留原判断。显式合法状态分别为 observation（active/withdrawn）、hypothesis（open/supported/challenged/withdrawn）、question（open/resolved/withdrawn），宿主不会自行宣布假设获得支持或问题已解决。

模型选择简短来源，例如 `{source_id:"profile:/columns/1/missing"}`，或者 `{source_id:"experiment:真实搜索实验ID:score"}`。成功 EDA 的 `knowledge_sources` 提供逐 finding 的 `source_id` 和陈述，引用时增加 `applicability` 说明。宿主补齐真实哈希、finding 序号和原始执行证据，再执行完整来源校验；模型不能自填可信分数、伪造来源或将历史预测换成另一模型。实验 failure 仅表示真实执行故障，不自动否定统计假设。

`knowledge_refs:["认识ID"]` 绑定本动作更新后的修订，未更新则绑定当前修订；需要使用历史版本时仍可传 `{id,revision}`。观察必须提供来源，supported 假设必须引用成功实验分数。简短接口与内部协议分离，程序调用的显式协议 3 字段仍可严格校验，错误状态和陈旧版本不会被静默修正。完整组初始上下文提供 `profile:/rows` 等示例，未知路径或未完成 finding 仍拒绝。原始模型响应和编译后的接受动作分别保存。

认识、候选、动作引用及资源一起预检；宿主持久化一次 `action_accepted` 后才更新状态和派发。任何非法来源、陈旧修订、额度拒绝或接受记录故障均不留下部分状态。检查入口重演接受事件，核对 `knowledge_control` 修订快照、基本概览哈希与实验事实；普通方法显示 disabled，旧记录显示 not_recorded。文字中的“supported”是模型判断，不改变可信指标排名。

新版分析参数为 `purpose`（explore/diagnose/compare）、`candidates`、`question`、`expected_evidence` 和 `source_experiments`。三个目的分别要求 0/1/2 个成功搜索来源；探索允许空候选。不接收 requested_budget、budget_reason 或 decision_rules，宿主按配置和剩余资源分配。训练可采用更早的分析，也可解释后不采用最近分析。

## 实验执行

新运行在首个模型请求前保存 `validation-plan.json`，包含原搜索身份、确认模式、两份固定额外划分（开启时）、划分/模型种子、算法和内容哈希。原 dataset 不修改。回归按稳定 ID 哈希划分，分类按冻结类别分层；两份额外划分必须彼此不同且不同于搜索，无法满足则预检拒绝，不反复换种子。

实验以 `phase: search/confirmation/final` 区分，成绩同时绑定指标协议与 `evaluation_id`。确认成绩不能进入搜索最佳排名，最终全量拟合的验证成绩为 null。`search_best_experiment_id` 与 `selected_experiment_id` 分列，检查入口重演短名单及确认排名，不依据文字判断覆盖成绩。

开启 `terminal_repeated_holdout` 后，接受完成即冻结搜索，按搜索指标取前两份不同代码哈希的成功流水线。同代码取最好成绩，平局取先完成者；候选优先级或暂缓不影响名单，同候选的不同实现可以同时入选。每份流水线分别在两份额外划分重新拟合，以额外两次成绩的均值选择，平局沿用搜索排名。报告逐划分成绩、均值和极差，不混入搜索成绩。任何规定确认失败或超时均为 incomplete，不按部分结果平均或退回未经确认交付；确认与最终拟合期间不再调用模型修代码。

这是训练内重采样与终局选择，EDA 和特征设计可能已接触这些训练标签，划分之间也有重叠，不能视为独立 holdout 或外层测试证据。schema 3 交付保存搜索最佳、实际所选、确认依据与冻结计划；预测复现和 refit 只使用所选流水线，不重新搜索或确认。

生成代码导出 `build_pipeline(seed)`，返回支持 `fit(X, y)` 的 scikit-learn 兼容流水线。预处理放入流水线；目标变换须在 predict 时逆变换。X 不含 ID 和目标列。运行镜像锁定 scikit-learn 1.7.2、scipy 1.16.2、joblib 1.5.2，不能运行时安装库。

每个实验分别启动新的拟合和预测容器，前者只发布内部训练数据，后者只发布模型、代码和无标签验证特征。模型仅在容器反序列化；宿主独立校验预测的 ID、类别和概率，再经可信 Python 入口计算冻结主指标。代码自报成绩不参与比较。每阶段保存原生事件、实际代码、Notebook、输入/镜像身份和产物快照。失败尝试保留，不复用其状态。

默认拟合上限 120 秒、预测 30 秒；建模默认内存上限 4 GiB、工作区 512 MiB、单产物 256 MiB、每执行会话累计产物 1 GiB，清理/中断宽限 15 秒。超时、取消、不完整收集或超限均不产生成功实验。累计额包含执行结束和关闭时的独立快照；传输帧默认按 base64 膨胀自动推导，显式配置保留。建模智能体会收到有效资源上限。实测依据、适用范围及覆盖方式见 [建模资源限制](modeling-resource-limits.md)。

新拟合以 stage 3 声明 `zlib-3` 压缩和单模型上限。压缩后超限会删除模型文件并产生 `ModelArtifactLimitError`，避免收集器因大文件陷入不完整保存。执行回执完整、内核可用且清理/记录成功时，搜索收到 `model_artifact_limit` 诊断及实际大小，可在原 `code_repairs` 上限内提交修正；失败模型不参与排名、不交接预测。未知执行、记录或清理故障仍停止任务，确认阶段仍禁止模型修改代码。

## 父运行与预算

父运行保存 modeling.json、追加 events.jsonl 和有界 payloads，关联每次训练阶段及 EDA 子运行。使用 `bun run modeling inspect --run RUN_DIRECTORY` 检查父运行和未确认子调用。原 EDA 的 manifest.json 与 Notebook 读取方式不变。

总模型尝试及 token 包含建模智能体和 EDA 全部角色/重试；EDA 子额度从父剩余量分配，结果按调用身份只结算一次。默认最多 3 次搜索拟合、1 次最终拟合，最终拟合/预测预留 180 秒；预留属于总任务 900 秒的一部分。未知模型用量导致全任务停止。总墙钟和阶段耗时分列，不能再次相加。

新运行记录纠错策略 `consecutive-unproductive-v1`：`action_corrections` 限制两次成功进展之间的拒绝次数，成功 EDA 或合法搜索分数使该计数清零；只有动作被接受、执行失败或资源被拒绝均不清零。资源拒绝同样计数，避免反复申请不可用动作。总调用、token、时间、拟合上限和代码修复额度不重置。错误反馈说明本次未提交、可修正原因和剩余纠正次数；训练反馈同时给出先前最佳成绩及本次是否改善。模型仍自主决定分析、建模方向和完成，历史累计纠错策略的失败记录不改写。

## 建模与定向 EDA

```sh
bun run modeling run --task configs/modeling/synthetic.json
```

此命令调用真实模型，使用配置中的 model_profile/eda_profile；`--model ID` 可同时覆盖两者。建模智能体只有 run_experiment/analyze/finish_modeling 三个动作。分析描述疑问、证据需求和可选候选；采用分析证据时须关联已接受的分析身份、来源实验与有效证据。普通运行允许直接训练或无 EDA 完成，协作验收则要求真实走过分析后训练。

每次 EDA 为独立双角色子运行，同次 EDA 内部共享 Notebook；多次调用通过显式文件和结构化结果交接。失败分析只作为诊断，不能引用为成功证据。后续训练变差时保留原最佳实验；平局保留先完成者。

完成动作冻结短名单，按配置执行确认并选定流水线，在全部允许训练数据上重新拟合，再对外层无标签特征预测。拟合/验证预测/最终预测均独立隔离。最终拟合失败不会降级为验证模型却报告成功。交付保存于父运行 delivery/，不在宿主反序列化模型。

```sh
bun run modeling reproduce --run RUN_DIRECTORY
bun run modeling reproduce --run RUN_DIRECTORY --mode refit
bun run modeling score --run RUN_DIRECTORY --labels-root PRIVATE_DIRECTORY --labels labels.csv
```

reproduce 默认在新容器恢复已保存模型，以 `atol=1e-8, rtol=1e-6` 比对预测；refit 则重新执行冻结流水线的全训练数据拟合及预测。两者均无 LLM 调用，独立保存到 runs/modeling-reproductions，不覆盖原运行。它们不重演分析与实验决策。输入或镜像身份不匹配时拒绝同条件复现。

score 只接受已完成且交付冻结的运行，私有标签 CSV 必须恰为 ID 列和目标列，样本与预测一一对应。结果保存在独立 runs/modeling-scores，搜索不会接收它。内层验证指标与外层测试指标分列，不用内层自适应分数证明泛化收益。

## 固定开发任务

`configs/modeling/dsbench-s3e9-selection.json` 冻结公开数据来源、哈希与精确内部划分。选择依据为公开 RMSE 回归、已下载且文件小；未按测试分数选择。该任务只用于开发，不代表完整 DSBench 适配或正式实验。

```sh
bun run modeling prepare --config configs/modeling/dsbench-s3e9-prepare.json --out runs/modeling-s3e9-data
```

目标 Strength，种子 42；使用本地 DSBench 重划分数据的样本身份，忽略旧 Kaggle 题面示例行数。无需下载原始补充数据。默认快速测试使用合成数据和可控模型，Docker 整链测试另行执行。

```sh
bun run test:smoke:modeling
```

这是独立付费入口，固定使用 `dsbench-s3e9.json` 和 deepseek-flash；调用前核对已提交的来源清单、输入哈希及精确划分。最多运行一次建模任务，全部角色共享 40 次尝试、600,000 token 阈值和 900 秒，EDA 子上限 20 次/400,000 token/300 秒。成功后无模型地复现预测并独立评分；任一验收失败保存 smoke-result.json、以非零退出且不自动加跑。预测改善不是通过条件。

## 候选状态与动作协议 v3

候选表示固定的建模假设，实验表示一次实际尝试。例：`linear_x` 的假设是残差随 x 变化、方向是线性拟合；改正代码错误或调整同方向参数保留该 ID，但每次均产生新的实验 ID。改用树模型属于新方向，应另建候选。宿主只检查身份和结构，不判断两个自然语言想法是否等价。

每个候选保存固定的 `id/hypothesis/change`、可更新的正整数优先级（越小越优先）、理由、证据和修订号。`pending` 表示尚无已接受实验意图；`tried` 表示已有尝试，不表示成功或假设有效；`deferred` 表示暂缓，恢复后由已有实验关联派生为 pending/tried。最终全量拟合仍关联所选候选，以 `final` 区别于搜索实验。未确认执行单独显示，不能作为修复来源自动重试。

三个工具都要求 `candidate_updates`（无变更时传 `[]`）。创建和更新随当前动作一起接受，没有额外候选管理工具或角色。批次中同一 ID 不能出现两次，不能覆盖固定定义、伪造状态/实验/成绩；暂缓候选须先恢复，可在本次动作中恢复。优先级是决策建议，允许解释后选择非首位候选。候选上限包含已暂缓候选。

首个 `run_experiment` 参数示例：

```json
{
  "candidate_updates": [{
    "op": "create", "id": "baseline",
    "hypothesis": "均值预测可作为参考", "change": "均值回归",
    "priority": 1, "reason": "建立可比较的参考成绩", "evidence": []
  }],
  "candidate_id": "baseline",
  "change": "使用默认均值策略", "reason": "取得内部验证 RMSE",
  "source_experiment": null, "repair_of_experiment": null, "evidence": [],
  "code": "from sklearn.dummy import DummyRegressor\ndef build_pipeline(seed):\n    return DummyRegressor()\n"
}
```

其后可在 `analyze` 中创建新的 `linear_x` 候选，`candidates` 只传已有或本次创建的 ID。分析返回后，在下一次训练同时提交证据关联更新及训练证据，例如以下更新项（身份替换为本次返回值）：

```json
{
  "op": "update", "id": "linear_x", "priority": 1, "disposition": "keep",
  "reason": "验证残差与 x 有关，优先检验线性方向",
  "evidence": [{
    "analysis_id": "analysis_id", "source_experiment": "baseline_experiment_id",
    "refs": ["cell_id"], "applicability": "同一冻结划分上的基线预测残差"
  }]
}
```

`disposition` 还可为 `defer/resume`；`priority:null` 保留原值。训练动作自身也要携带相应 evidence，候选更新的证据不能代替训练证据。代码失败后修复用同一候选的 `repair_of_experiment` 指向已确认失败的非最终实验；成功、未知或其他候选实验均拒绝。`source_experiment` 描述分析/决策来源，和修复来源是两个独立关系。

典型事件顺序：接受初始候选与训练 → 实验意图/结果 → 接受新候选与分析分配 → EDA 子意图/结果 → 接受带证据的候选更新与训练 → 实验结果 → 接受完成动作 → 最终拟合/预测及交付。后续更差成绩不替换可信最佳。完成动作可同时暂缓剩余方向。

宿主先验证整项动作、全部候选更新、证据来源、修复关系和预算，再持久化 `action_accepted`，然后更新快照并派发。非法批次和预算拒绝不会留下部分候选更新或触发执行，但本轮已发生的模型调用仍计费。接受日志写入失败则不执行；日志已写而快照/执行被中断时，inspect 显示已接受决定和未确认实验，不伪造成功。

## 分析交接与宿主资源分配

每次 EDA 都有独立执行会话。输入包括允许的训练数据、原搜索划分、source.json 和有界 context.json；探索没有预测来源，诊断有一个，比较有两个成功搜索实验。双模型预测分别按稳定 ID 与真实标签连接，保留各自预测哈希、评价身份、模型种子及分类概率字段映射；列名冲突时添加下划线。外层测试、确认阶段成绩和私有标签不会传入分析搜索。

context.json 显式携带相关候选、认识的准确修订、原始证据来源与开放问题；历史认识标注其历史身份，不伪装为本轮发现。最多 128 KiB；提示中的认识视图最多 24 条、64 KiB，显式引用优先，其他省略项列出 ID/修订。必需引用超限则拒绝，不静默丢失。上下文产物与模型实际请求分别记录哈希。第二次分析不会获得上一次 Notebook 的隐式变量。

analyze 不再要求申请额度。宿主使用分配记录 v2 的 host-cap-v1 策略，逐项取配置与真实剩余量的最小值，时间扣除收尾预留。eda_executions 是父任务累计上限。分配记录保存 effective/remaining/limits/clipped；无可用量则拒绝。旧 requested_budget/budget_reason/decision_rules 参数在新协议中拒绝。

截止时间从父动作接受时开始，包含输入准备、角色切换、模型与执行。同次 EDA 的规划者、执行者和重试共享额度。未派发的准备失败记录已知零模型消费；派发后用量未知则停止父任务。已知失败返回诊断，不能当作成功证据。取消向活动子运行传播并清理会话。

建模 EDA 显式启用 `modeling-diagnostic-v1` 收尾策略，所有允许 EDA 的方法共用。每次生成上限为 8,192 token（仍受模型配置与真实剩余量裁剪），优先分析已有预测与统计，候选拟合建议交回建模端。宿主根据两角色当前请求的保守字节估计、返回内容余量和剩余调用/执行/时间，在硬上限前触发 `analysis_closing`，保存触发原因及数值；之后执行者只能 `return_result`、规划者只能 `finish_analysis`，宿主拒绝新执行或委派。保留完整历史及原证据校验；未解问题如实写入局限，没有有效证据不能完成。独立 EDA 默认不启用该策略。

额度不预扣，实际消费按子运行身份只结算一次，核对双角色小计。token 是停止阈值，已经派发的响应可能越过阈值，全部照实记账；父墙钟与其包含的子耗时不能相加。收尾确认失败、取消、记录故障或未知执行不产生部分确认排名，不回退为未经确认的交付；inspect 保留接受意图和未确认实验。

## 独立方法开发入口

共享配置见 configs/modeling/methods.json 和 resources/collaboration-dev-v1.json。以下命令仅预检，不调用模型、不训练，也不遍历其他任务：

```sh
bun run modeling develop --task binary --method collaborative --seed 42 --resource configs/modeling/resources/collaboration-dev-v1.json --preflight
```

任务只能显式选 s3e9/binary/multiclass，方法必须显式指定。种子须匹配已准备数据的冻结种子；变更种子需要独立准备新数据版本。输出包含完整任务、指标与数据身份、工具集合、确认划分/种子/哈希以及搜索和收尾额度。普通 run 也支持 --preflight、--method、--resource 和 --seed。

移除 --preflight 才启动选定任务一次，调用真实模型；完整协同开发目标明确要求探索先行、两次分析、来源修订及后续训练，验收不要求某次分析后分数提升。终局完成后独立复现预测，保存不可覆盖的 smoke-result.json，失败不自动重跑。新入口不读取外层标签；独立 score 仍由操作者另行执行。

collaboration-dev-v1 每任务 45 分钟、80 次模型尝试、1,200,000 token 阈值、12 次拟合（最多 7 次搜索、4 次确认、1 次最终拟合），收尾预留 750 秒。最多 3 次 EDA，累计 30 次执行，每次上限 20 次模型尝试、400,000 token、300 秒；父剩余额度仍约束每次分配。这是根据历史调用与无 LLM 训练测量制定的开发保护上限，不是预计费用、正式预算或效果保证。依据及实际执行状态见验收记录。

## 记录兼容与回退

新父记录和交付为 schema 3，数据仍为 schema 1/2，新 runner stage 为 3；各版本含义不能互换。交付保存 `stage_version`，复现沿用该版本；旧交付未记录时保留原 stage 1/2 协议及镜像，不向旧镜像注入新字段。inspect 重演动作、认识、评价身份、短名单与确认排名，核对产物哈希及实际消费。新格式缺少必需的确认/选择字段不能按旧格式降级读取。

schema 1/2 父记录和交付使用冻结旧动作与配置解析，不补造方法、认识或确认身份，不改写源文件；保持原代码、镜像、类别/概率及选中模型的复现/评分语义。新运行不能直接用旧任务配置启动。回退代码时保留新记录，以对应版本代码读取；不能把新记录降为旧版本。历史验收报告保持原文，见 [候选/预算历史报告](modeling-candidate-budget-validation.md) 与 [分类历史报告](modeling-classification-validation.md)。

## 表格任务协议与分类数据准备

新准备产物使用 dataset schema 2；schema 1 回归数据继续只读加载，保留原划分。支持矩阵为 regression/rmse、binary/accuracy/roc_auc/log_loss、multiclass/accuracy/log_loss。二分类必须显式提供 `positive_class`，多分类至少三类且不接受该字段。

分类目标按 CSV 原始字符串保留（例如 `01` 与 `1` 不同，`NA` 是合法标签），拒绝空白目标。类别按 UTF-8 字节排序映射到整数。默认分类划分在每类内按种子与 ID 哈希排序，验证样本数为 `min(n-1,max(1,floor(0.2*n)))`；少于两条的类别拒绝。显式划分也必须完整且两侧覆盖全部类别。小样本时实际比例不一定为 20%，精确成员写入清单。

```sh
bun run modeling prepare --config configs/modeling/binary-prepare.json --out runs/modeling-binary-data
bun run modeling prepare --config configs/modeling/multiclass-prepare.json --out runs/modeling-multiclass-data
```

这些命令只准备合成数据，不调用模型；输出目录必须尚不存在。各示例有 60 条训练来源记录，冻结为 48 条内部训练和 12 条验证。数据与协议校验值在每次加载时核对。

## 分类接口与可信评分

分类训练时 y 已按冻结 classes 顺序编码为整数 0..K-1。accuracy 需要 predict 返回这些整数；ROC AUC/log-loss 需要 predict_proba 和 classes_，后者恰好覆盖所有整数类别，顺序可以不同。runner 对齐概率列并解码标签。概率型输出包含 ID、prediction 和 probability_0..K-1；accuracy 只有 ID 和预测标签。列名与 ID 冲突时按协议追加下划线，以 dataset.protocol.prediction 为准。模型与 model-metadata.json 都保存协议，宿主验证元信息并纳入交付文件哈希。

概率必须有限、位于 [0,1]，行和误差不超过 1e-6；类别取 argmax，并列选冻结顺序中第一类。非法概率不能进入最佳实验或 EDA。宿主按稳定 ID 重排预测，拒绝重复、缺失、多余 ID、未知类别及标签/概率不一致。

评分版本为 tabular-metrics-v1：

- RMSE：原尺度平方误差均值的平方根，越小越好。
- accuracy：标签字符串完全相等的比例，越大越好。
- ROC AUC：显式正类的概率，排序并列取平均秩，越大越好；仅适用于二分类，评分样本必须包含两类。
- log-loss：合法 float64 概率的工作副本先按行归一化，再裁剪到 [1e-15,1-1e-15] 后重新归一化，取真实类别负对数均值，越小越好。这个固定数值规则不修改原概率文件。

评分经 uv run --offline --frozen 调用固定 Python 模块，不导入候选、不加载模型、不传入模型密钥。请求/回复各限 1 MiB，stderr 限 64 KiB；单次默认 30 秒，上限裁剪至父探索剩余时间，取消/超时终止且不重试。无效预测记为实验失败；评分进程或协议故障终止父运行并保存诊断。独立 score 的错误留在单独评分目录。

## 分类诊断与版本兼容

EDA 的 source.json 描述冻结协议、真实标签字段、预测字段、实际可用概率列及对应类别，并绑定预测产物哈希。validation.csv 以稳定 ID 连接原标签与预测，新增字段遇原特征同名时追加下划线。accuracy 不补算概率；纯数据分析的预测来源为 null。可按需诊断混淆、类别分布或置信度，返回证据后由建模智能体决定下一项实验。普通 run 不强制调用 EDA，也不强制后续成绩提升。

dataset schema 2 的分类协议保持不变。新父 modeling.json 和 delivery.json 使用 schema 3，内部 score 另绑定 evaluation_id；失败和最终拟合 score 为 null。inspect 与在线选择使用同一指标方向和平局规则，并检查来源身份。候选控制扩展仍为 1。

旧 schema 1 回归数据与父记录只读兼容，新运行可读取旧数据而不重写划分。旧交付复现使用原镜像和原三字段 stage.json；新交付使用版本化 stage 与模型元信息。预测复现对类别逐项精确比较，对概率/回归数值使用交付冻结的 atol=1e-8、rtol=1e-6。refit 重训冻结流水线，不重新搜索。旧程序不能读取 v2；回退时保留新记录，以原代码和镜像继续读取 v1。

分类功能检查、镜像身份与真实模型状态见 [分类验收记录](modeling-classification-validation.md)。
