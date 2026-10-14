# 建模智能体

支持表格回归、二分类、多分类、有序类别、多目标二分类与前三候选输出，复用实验历史、定向双角色 EDA、预算及隔离执行。历史配置与新版基准配置按版本区分。

建模基准使用 v2 通用目标协议与全指标计算，详见 [指标、预测语义和差分记录](modeling-metrics.md)。逐目标类别/正类、等级坐标、指标范围及未定义边界由共享定义冻结。新版原生训练、EDA 交接、冻结、预测、独立复现、测试评分及官方 system wrapper 已有合成 Docker 验收；统一基准批次已接入并完成 10 项真实数据确定性闭环及独立预测复现，状态见 [建模基准验收记录](modeling-benchmarks-validation.md)。

以下入口只校验合成协议，不读模型配置、不启动训练或调用 API；输出 `scope=protocol-only`，不能代替数据/执行预检：

```bash
bun run modeling protocol --config configs/modeling/protocol-multilabel.json
bun run modeling protocol --config configs/modeling/protocol-ranked.json
```

所有目标与特征必须互斥，二元目标逐一指定正类；未知指标、错误参数/版本、空目标或非法等级映射都会拒绝。预测按 ID 对齐，概率不静默修正，多目标任一未定义导致聚合失败。旧 v1 数值和哈希继续保留，不原地迁移。

## 基准数据的原生入口（任务 schema 4）

`configs/modeling/benchmark-titanic.json` 使用准备清单 schema 3、目标协议 v2、stage 4、提示词 modeling-v9、父记录/交付 schema 5。`modeling-decision-v2` 与三种核心动作保持不变。v9 补回已安装库、无网络安装、独立预测进程及模块级可序列化自定义类约束；四方法共享，不规定模型家族或 EDA 次数。模型和指标从已冻结的数据协议读取，不能在运行配置中改写。旧任务 schema 3、数据 schema 1/2 继续走原协议；下文历史示例中的字段与数值规则不变。

先准备数据并检查配置；以下两个命令均不调用模型 API：

```bash
mkdir -p runs/modeling-benchmarks
bun run evaluate prepare --config configs/evaluations/dsbench-modeling-prepare.json --out runs/modeling-benchmarks/titanic
bun run modeling run --task configs/modeling/benchmark-titanic.json --preflight
```

镜像需由当前 `Dockerfile` 构建并具有 `org.statigent.modeling-stage=4` 标签。预检验证数据、逐目标类别覆盖、固定确认划分、资源预留和镜像能力；运行使用检查得到的不可变镜像 ID。准备成本、概览成本包含在父墙钟中，并保存明细。真实模型开发冒烟已按批准范围启动，首次运行、失败及续跑证据见 [验收记录](modeling-benchmarks-validation.md)；不据此推定正式实验已通过。

`delivery_mode` 必须显式为 `fit_only` 或 `fit_predict`。前者完成内部搜索、配置的确认和全训练拟合，输出 `status=model_frozen`、`delivery.status=pending_prediction`；准备数据可以完全没有测试分区。`modeling fit --task FILE` 显式选择该模式。后者由普通 `modeling run --task FILE` 在同一父时限和收尾预留内继续预测，成功后才输出 `completed`。最终拟合不读取预测分区；冻结后不再调用 LLM、调参或重新确认。

冻结清单位于 `frozen/model.json`，引用原生阶段中的模型字节，保存候选代码、完整特征模式、协议与镜像身份。独立预测不会重新拟合；每次创建独立目录，保存请求、阶段、规范预测和墙钟成本：

```bash
bun run modeling predict --run PARENT_RUN --features-root runs/modeling-benchmarks/titanic --features final-prediction/test.csv --timeout-ms 30000
bun run modeling inspect --run PARENT_RUN
```

预测输入必须使用准备后的列顺序、稳定 ID 和缺失值编码，包含全部允许特征且不含任何目标。新数据也必须遵守同一特征模式。坏输入、超时或取消留下失败记录，保留冻结模型，不回到搜索。模型只在 Docker 中加载；宿主校验和传送字节。预测失败后的父交付不标为完成。

基础概览 v2 扫描内部拟合成员，保留完整特征描述文件；提示最多展示 128 列，优先展示 ID 和全部目标，并记录省略列数及原始列索引。宽表不删除训练特征，四方法获得同一概览。EDA 的 `source.json` v3 列出全部目标、独立概率列与可用训练诊断；数据和每份预测按 ID 关联，不能按行位置拼接。旧概览 v1 仍按原限制读取和检查。

schema 5 完整交付支持以下独立、零 LLM 操作；每次生成新目录，不改写源交付：

```bash
bun run modeling reproduce --run PARENT_RUN --mode predict
bun run modeling reproduce --run PARENT_RUN --mode refit
bun run modeling score --run PARENT_RUN --labels-root runs/modeling-benchmarks/titanic --labels evaluator/labels.csv
```

`predict` 复用冻结模型；`refit` 使用已选代码、完整训练数据和冻结种子，只重新拟合一次，不重开搜索或确认。两者使用原任务的最终阶段时限，按 ID 对齐后逐目标比较全部字段：标签和前三候选顺序精确一致，数值及各目标独立概率采用 `atol=1e-8, rtol=1e-6`。总指标相同不能代替逐字段复现。异常中无法确认的执行次数为 null，不伪报零成本。

`score` 只核对冻结身份、公开预测输入、预测字节和指定标签，不打开模型文件或训练阶段目录；测试分区拥有独立 evaluation_id，不参与搜索排名。多目标分数保留按协议排序的每目标 ROC AUC 和均值，错误目标、错误聚合或协议身份会被拒绝。序数类别、前三候选和七目标的实际 Docker 测试见 `tests/integration/modeling-reproduction-v2.test.ts`。inspect 继续只读支持父记录 schema 1–4；schema 5 额外检查原生阶段、冻结及预测事件和身份，不向历史记录补造新字段。

TabArena 使用同一 fit-only 与冻结预测接口，薄 Python wrapper 通过有界 Bun 桥接调用原生父循环。官方 CPU/内存/训练时限映射到任务限制，预测拥有独立时限；standalone 仍由一个父预算覆盖 fit→predict。安装、零 LLM 示例、类别顺序和 cleanup 语义见 [官方 system 兼容环境](../environments/tabarena/README.md)。合成官方调用及 3 项真实 r0f0 验证均已通过；付费智能体首次矩阵的当前状态见 [验收记录](modeling-benchmarks-validation.md)。

## 研究方向与当前实现

第二章采用“分析与建模协同驱动的自主机器学习方法”，以独立测试预测效果为主，同时关注可靠性与实际效率。三项核心机制、研究假设和消融以 [研究大纲](overview.md#第二核心章节面向预测性数据建模的智能体研究) 为准，评价口径见 [Benchmark 协议](benchmark.md#第二章预测性建模)。预算管理在研究中承担运行保护与公平控制的作用。

新版实现包含可选笔记、自主分析交接、训练诊断、统一收尾及四种方法权限。任务 schema 3、模型侧接口 modeling-decision-v2、动作协议 4、提示词 modeling-v7、父记录与交付 schema 4 配套使用。固定原始数据与搜索划分继续保留。软件检查、真实模型验收和研究效果分别报告，见 [本轮开发验收](modeling-workflow-validation.md)。

当前默认一次 EDA、三次搜索拟合和一次最终拟合用于开发验证，不代表正式实验的协同深度或资源条件。历史验收记录保留其当时配置与结论；功能链路通过不等于上述方法具有稳定的预测收益。

## 新任务配置与基础概览

新启动配置要求 `schema_version: 3`、`method`、`confirmation: {"mode": "none" | "terminal_repeated_holdout"}` 和 `resource_version`。四组共享基础概览、实验历史、训练、确认和交付能力：

| method | 分析与认识机制 |
| --- | --- |
| no_eda | 无 EDA 工具 |
| initial_eda | 首次模型决策前由宿主固定委派一次任务相关 EDA；已知失败可继续建模，不自动重做 |
| adaptive_eda | 智能体按需调用 EDA，保留普通动作与结果历史 |
| collaborative | 按需 EDA 加可替换笔记、来源和 EDA 笔记交接 |

普通三组不提供笔记字段，越权提交笔记会警告并忽略；no_eda/initial_eda 的模型无法通过伪造 analyze 调用越权。未使用 EDA 不产生虚拟消费。

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

## 可选笔记与统一来源

完整协同模式可随动作提交 `notes: {text, sources?}`，省略保留旧版，空文本清空。宿主生成递增 revision 和接受序号，文本限 8 KiB UTF-8，每组 sources 最多 16 项。不要求认识类型、状态、基版本或候选事务。笔记是待检验的模型判断，不是可信指标。其他方法保留普通任务、报告和实验历史，不接收额外笔记状态。

所有方法可附加 `sources: [{source_id, applicability?}]`。句柄为 `profile:/rows` 等概览路径、`analysis:<id>:<finding序号>`、`experiment:<id>:score/failure/train_diagnostic`。宿主绑定本任务的原数据、评价身份、预测及证据；探索 finding 始终没有模型来源，不能随以后的训练改写。失败 EDA 不能成为 finding，实验 failure 仅证明执行失败。

核心动作先检查工具数量、必需字段、实验关系、权限及资源。核心非法时整项拒绝；核心合法后逐条验证来源、整份验证笔记。错误附加项只警告并忽略，非法笔记保留旧版，不消耗核心纠错次数。接受事件保存原始参数、有效动作和警告，持久记录成功后才更新快照和派发；记录失败不执行。inspect 重演这些绑定和笔记版本，不将模型原文自动视为证据。

## 实验执行

新运行在首个模型请求前保存 `validation-plan.json`，包含原搜索身份、确认模式、两份固定额外划分（开启时）、划分/模型种子、算法和内容哈希。原 dataset 不修改。回归按稳定 ID 哈希划分，分类按冻结类别分层；两份额外划分必须彼此不同且不同于搜索，无法满足则预检拒绝，不反复换种子。

实验以 `phase: search/confirmation/final` 区分，成绩同时绑定指标协议与 `evaluation_id`。确认成绩不能进入搜索最佳排名，最终全量拟合的验证成绩为 null。`search_best_experiment_id` 与 `selected_experiment_id` 分列，检查入口重演短名单及确认排名，不依据文字判断覆盖成绩。

开启 `terminal_repeated_holdout` 后，接受完成即冻结搜索，按搜索指标取前两份不同代码哈希的成功流水线。同代码取最好成绩，平局取先完成者；名单由实际实验与代码哈希决定。每份流水线分别在两份额外划分重新拟合，以额外两次成绩的均值选择，平局沿用搜索排名。报告逐划分成绩、均值和极差，不混入搜索成绩。任何规定确认失败或超时均为 incomplete，不按部分结果平均或退回未经确认交付；确认与最终拟合期间不再调用模型修代码。

这是训练内重采样与终局选择，EDA 和特征设计可能已接触这些训练标签，划分之间也有重叠，不能视为独立 holdout 或外层测试证据。schema 4 交付保存搜索最佳、实际所选、确认依据与冻结计划；预测复现和 refit 只使用所选流水线，不重新搜索或确认。

生成代码导出 `build_pipeline(seed)`，返回支持 `fit(X, y)` 的 scikit-learn 兼容流水线。预处理放入流水线；目标变换须在 predict 时逆变换。X 不含 ID 和目标列。运行镜像锁定 scikit-learn 1.7.2、scipy 1.16.2、joblib 1.5.2，不能运行时安装库。

协议 2 的 `modeling-v10` 提示明确要求接受任意无符号 32 位种子，搜索、确认与最终训练可能使用不同种子。组件随机性使用传入种子；派生种子先转为 Python 整数，再按 `2**32` 取模，例如 `(int(seed) * 10 + i) % (2**32)`。不能假设种子始终是开发配置中的小整数。该契约补充不改变冻结划分、宿主种子算法或旧协议提示。

每个实验分别启动新的拟合和预测容器，前者只发布内部训练数据，后者只发布模型、代码和无标签验证特征。模型仅在容器反序列化；宿主独立校验预测的 ID、类别和概率，再经可信 Python 入口计算冻结主指标。代码自报成绩不参与比较。每阶段保存原生事件、实际代码、Notebook、输入/镜像身份和产物快照。失败尝试保留，不复用其状态。

默认拟合上限 120 秒、预测 30 秒；建模默认内存上限 4 GiB、工作区 512 MiB、单产物 256 MiB、每执行会话累计产物 1 GiB，清理/中断宽限 15 秒。超时、取消、不完整收集或超限均不产生成功实验。累计额包含执行结束和关闭时的独立快照；传输帧默认按 base64 膨胀自动推导，显式配置保留。建模智能体会收到有效资源上限。实测依据、适用范围及覆盖方式见 [建模资源限制](modeling-resource-limits.md)。

新拟合以 stage 3 声明 `zlib-3` 压缩和单模型上限。压缩后超限会删除模型文件并产生 `ModelArtifactLimitError`，避免收集器因大文件陷入不完整保存。执行回执完整、内核可用且清理/记录成功时，搜索收到 `model_artifact_limit` 诊断及实际大小，可在连续无进展保护范围内提交修正；失败模型不参与排名、不交接预测。未知执行、记录或清理故障仍停止任务，确认阶段仍禁止模型修改代码。

## 父运行、故障恢复与收尾

父运行保存 modeling.json、追加 events.jsonl 和有界 payloads，关联训练、辅助诊断及 EDA 子运行。`bun run modeling inspect --run RUN_DIRECTORY` 重演动作、实验关系、笔记、警告、评价和确认排名，列出未确认调用。原 EDA 的 manifest.json 与 Notebook 协议不变。

总调用和 token 包含建模及 EDA 全部角色与重试，子消费按身份只结算一次。未知用量保持 unknown 并停止新增 LLM。若已有可信搜索最佳、执行与清理明确、记录可写、未取消且确认和最终拟合预留足够，可无 LLM 进入原确定性收尾。普通已确认训练/EDA 失败可返回诊断继续决策；取消、总时限、记录失败、完整性故障或未知执行/清理均停止新执行。

已知用量的模型响应若以 `length` 结束，丢弃截断内容；已有可信候选且仍满足原保护条件时，以 `protected/response_length` 进入相同的确认、最终拟合和预测，不追加模型调用。审计核对最后一条未被接受为动作的保存响应确实为截断；内容过滤、无候选、取消及执行不完整不借此收尾。

纠错策略 `consecutive-unproductive-v2`：核心拒绝、不可派发请求和失败执行累计，成功分析或有效搜索分数重置，附加警告不计入。达到保护边界后按交付资格收尾或保留失败。不自动重试未知请求，不请求另一个模型补写完成。

明确完成与宿主保护共享唯一 search_frozen 事件和 finalize 入口，均执行原确认、全量拟合和预测；确认任一失败仍不能交付。三个维度独立记录：

| 维度 | 示例与含义 |
| --- | --- |
| search_end | agent_finished 为主动完成，protected 为宿主保护停止；failed/cancelled 保留真实原因 |
| delivery | not_started/running/completed/failed/cancelled；artifact 只关联真实完整交付 |
| usage.tokens.status | known/unknown；交付成功不会补造未知用量 |

例如 search_end=protected/accounting_incomplete、delivery=completed、accounting=unknown 表示受保护交付，不是自主完成。根 completed 要求交付成功，不能用现成搜索模型代替最终交付。父墙钟已包含子阶段耗时，各分项只作解释，不能再次相加。

## 建模与定向 EDA

```sh
bun run modeling run --task configs/modeling/synthetic.json
```

此命令调用真实模型，使用配置中的 model_profile/eda_profile；`--model ID` 可同时覆盖两者。建模智能体只有 run_experiment/analyze/finish_modeling 三个动作。分析描述疑问及零至两个成功搜索来源，附加引用由宿主核验。自然开发运行允许直接训练或无 EDA 完成，可控协同链路测试另行核验分析与后续实验的关联。

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

## 三个最小动作与实验历史

| 工具 | 核心参数 |
| --- | --- |
| analyze | question，可选 source_experiments（零至两个成功搜索实验，同一评价身份） |
| run_experiment | code、change、reason，可选 source_experiment、repair_of_experiment |
| finish_modeling | reason |

宿主根据分析来源数推断探索、诊断或对比，生成实验 ID，记录方案沿用和修复关系。repair_of_experiment 必须是已确认失败的搜索实验；未知实验不能重试。未执行想法只留在笔记，不生成待办候选，也无须在完成时关闭状态。完成不接收最佳 ID，宿主按真实分数选择。

首个训练可直接提交：

```json
{"code":"from sklearn.dummy import DummyRegressor\ndef build_pipeline(seed):\n    return DummyRegressor()\n","change":"建立均值参考","reason":"取得可比较的内部验证结果"}
```

工具未知字段没有执行语义；缺少核心字段、多工具响应、错误核心来源或超限代码均拒绝。附加字段处理见上文。事件依次保存接受、派发意图、实际结果；未确认执行单独列出，不伪造实验成功或用其生成修复对象。

## 训练与验证诊断

成功搜索先完成验证预测和可信评分，再复用同一保存模型预测该次 fit 的训练成员，预测输入不含目标。宿主独立评分，保存 training_diagnostic 的 partition=train、成员/模型/预测哈希、指标、状态和 elapsed_ms，不增加 fit。确认和最终拟合不产生该辅助阶段。

训练分数仅解释拟合与验证差异，不参与最佳排名，也不是独立测试。普通辅助预测失败记录 unavailable 和原因，保留合法验证分数；未知执行、清理或完整性故障停止后续执行。反馈发布实际可用的 train_diagnostic 来源，诊断预测与评分耗时已包含在父任务中。

EDA 输入用 validation.csv 与 training-diagnostics.csv 分列；双模型文件名带真实实验 ID。source.json.sources 的 partition、path、fields 和 training 字段明确分区、类别概率映射、模型与成员身份。不可用训练诊断显式标注，不向 EDA 开放模型二进制或整个运行目录。

## 分析交接与宿主资源分配

每次 EDA 都有独立执行会话。输入包括允许的训练数据、原搜索划分、source.json 和有界 context.json；探索没有预测来源，诊断有一个，比较有两个成功搜索实验。双模型预测分别按稳定 ID 与真实标签连接，保留各自预测哈希、评价身份、模型种子及分类概率字段映射；列名冲突时添加下划线。外层测试、确认阶段成绩和私有标签不会传入分析搜索。

context.json 保存问题，仅 collaborative 增加最新笔记快照与原始来源；历史判断不伪装为本轮发现。总输入上下文最多 128 KiB，笔记文本最多 8 KiB，来源最多 16 项。上下文产物与模型实际请求分别记录哈希。第二次分析不会获得上一次 Notebook 的隐式变量。

analyze 不再要求申请额度。宿主使用分配记录 v2 的 host-cap-v1 策略，逐项取配置与真实剩余量的最小值，时间扣除收尾预留。eda_executions 是父任务累计上限。分配记录保存 effective/remaining/limits/clipped；无可用量则拒绝。旧额度申请字段在新协议中不获得执行语义。

截止时间从父动作接受时开始，包含输入准备、角色切换、模型与执行。同次 EDA 的规划者、执行者和重试共享额度。未派发的准备失败记录已知零模型消费；派发后用量未知则停止新增模型请求，是否收尾由父任务执行资格决定。已知失败返回诊断，不能当作成功证据。取消向活动子运行传播并清理会话。

建模 EDA 显式启用 `modeling-diagnostic-v1` 收尾策略，所有允许 EDA 的方法共用。每次生成上限为 8,192 token（仍受模型配置与真实剩余量裁剪），优先分析已有预测与统计，候选拟合建议交回建模端。宿主根据两角色当前请求的保守字节估计、返回内容余量和剩余调用/执行/时间，在硬上限前触发 `analysis_closing`，保存触发原因及数值；之后执行者只能 `return_result`、规划者只能 `finish_analysis`，宿主拒绝新执行或委派。保留完整历史及原证据校验；未解问题如实写入局限，没有有效证据不能完成。独立 EDA 默认不启用该策略。

额度不预扣，实际消费按子运行身份只结算一次，核对双角色小计。token 是停止阈值，已经派发的响应可能越过阈值，全部照实记账；父墙钟与其包含的子耗时不能相加。收尾确认失败、取消、记录故障或未知执行不产生部分确认排名，不回退为未经确认的交付；inspect 保留接受意图和未确认实验。

## 独立方法开发入口

共享配置见 configs/modeling/methods.json 和 resources/workflow-dev-v1.json。以下命令仅预检，不调用模型、不训练，也不遍历其他任务：

```sh
bun run modeling develop --task binary --method collaborative --seed 42 --resource configs/modeling/resources/workflow-dev-v1.json --preflight
```

任务只能显式选 s3e9/binary/multiclass，方法必须显式指定。种子须匹配已准备数据的冻结种子；变更种子需要独立准备新数据版本。输出包含完整任务、指标与数据身份、工具集合、确认划分/种子/哈希以及搜索和收尾额度。普通 run 也支持 --preflight、--method、--resource 和 --seed。

移除 --preflight 才启动选定任务一次，调用真实模型；目标直接使用自然建模需求，不规定分析次数或动作顺序。验收检查合法交付和独立预测复现；未实际发生分析—实验关联时标为未覆盖，保护交付不报告自主完成。终局完成后独立复现预测，保存不可覆盖的 smoke-result.json，失败不自动重跑。新入口不读取外层标签；独立 score 仍由操作者另行执行。

workflow-dev-v1 每任务 45 分钟、80 次模型尝试、1,200,000 token 阈值，training_attempts:null 明确关闭总拟合次数上限，逐次照实记录；省略仍使用有限默认值。保留最多 4 次确认、1 次最终拟合，收尾预留 750 秒。历史 collaboration-dev-v1 不改写。最多 3 次 EDA，累计 30 次执行，每次上限 20 次模型尝试、400,000 token、300 秒；父剩余额度仍约束每次分配。这是根据历史调用与无 LLM 训练测量制定的开发保护上限，不是预计费用、正式预算或效果保证。依据及实际执行状态见验收记录。

本次真实开发验收仅 s3e9、collaborative/no_eda 各一次，seed 42、deepseek-flash、同一 workflow-dev-v1 和原冻结数据。完整检查通过并提交代码后才执行，不读外层测试标签，不自动重跑；报告核心拒绝、附加警告、无进展、保护原因、实际协同与复现状态。微小 RMSE 差异不作为通过依据。

## 记录兼容与回退

新父记录和交付为 schema 4，任务为 schema 3，数据仍为 schema 1/2，新 runner stage 为 3；各版本含义不能互换。交付保存 `stage_version`，复现沿用该版本；旧交付未记录时保留原 stage 1/2 协议及镜像，不向旧镜像注入新字段。inspect 重演动作、笔记、评价身份、短名单与确认排名，核对产物哈希及实际消费。新格式缺少必需的确认/选择字段不能按旧格式降级读取。

schema 1/2/3 父记录和交付使用冻结旧动作与配置解析，不补造方法、认识或确认身份，不改写源文件；保持原代码、镜像、类别/概率及选中模型的复现/评分语义。新运行不能直接用旧任务配置启动。回退代码时保留新记录，以对应版本代码读取；不能把新记录降为旧版本。历史验收报告保持原文，见 [候选/预算历史报告](modeling-candidate-budget-validation.md) 与 [分类历史报告](modeling-classification-validation.md)。

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

dataset schema 2 的分类协议保持不变。新父 modeling.json 和 delivery.json 使用 schema 4，内部 score 另绑定 evaluation_id；失败和最终拟合 score 为 null。inspect 与在线选择使用同一指标方向和平局规则，并检查来源身份。新运行不维护候选控制或类型化认识扩展；旧版读取保持原语义。

旧 schema 1 回归数据与父记录只读兼容，新运行可读取旧数据而不重写划分。旧交付复现使用原镜像和原三字段 stage.json；新交付使用版本化 stage 与模型元信息。预测复现对类别逐项精确比较，对概率/回归数值使用交付冻结的 atol=1e-8、rtol=1e-6。refit 重训冻结流水线，不重新搜索。旧程序不能读取 v2；回退时保留新记录，以原代码和镜像继续读取 v1。

分类功能检查、镜像身份与真实模型状态见 [分类验收记录](modeling-classification-validation.md)。
