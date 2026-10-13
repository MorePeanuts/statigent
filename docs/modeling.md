# 建模智能体

当前变更分阶段实现回归/RMSE 闭环。分类和其他指标在预检时拒绝。

## 准备数据

输入为一个带目标的训练 CSV 和一个不含目标的预测 CSV，必须有不重叠的唯一稳定 ID、相同特征及有限数值目标。ID 不作为训练特征。准备过程不读取测试标签、不调用模型、不修改源数据。

```sh
bun run modeling prepare --config configs/modeling/synthetic-prepare.json --out runs/modeling-synthetic-data
```

输出目录必须尚不存在，父目录必须存在。生成只读 train.csv/test.csv 和 dataset.json，后者保存文件哈希、目标、种子、指标方向及精确内部划分。默认按 seed 与行 ID 哈希排序生成 80/20 留出；可显式给出完整且不相交的 split.train/split.validation ID 清单。搜索不能重新划分。

源配置使用 input_root/train/test/target/id_column/kind/metric/seed；只接受 regression/rmse。原始数据和准备产物不提交 Git。每次加载校验哈希、列结构和划分成员，输入变化须重新准备并保留新版本。

## 实验执行

生成代码导出 `build_pipeline(seed)`，返回支持 `fit(X, y)`/`predict(X)` 的 scikit-learn 兼容回归流水线。预处理放入流水线；目标变换须在 predict 时逆变换。X 不含 ID 和目标列。运行镜像锁定 scikit-learn 1.7.2、scipy 1.16.2、joblib 1.5.2，不能运行时安装库。

每个实验分别启动新的拟合和预测容器，前者只发布内部训练数据，后者只发布模型、代码和无标签验证特征。模型仅在容器反序列化；宿主校验预测的 ID、列和有限值，再独立计算原尺度 RMSE。代码自报成绩不参与比较。每阶段保存原生事件、实际代码、Notebook、输入/镜像身份和产物快照。失败尝试保留，不复用其状态。

默认拟合上限 120 秒、预测 30 秒；建模默认内存上限 4 GiB、工作区 512 MiB、单产物 256 MiB、每执行会话累计产物 1 GiB，清理/中断宽限 15 秒。超时、取消、不完整收集或超限均不产生成功实验。累计额包含执行结束和关闭时的独立快照；传输帧默认按 base64 膨胀自动推导，显式配置保留。建模智能体会收到有效资源上限。实测依据、适用范围及覆盖方式见 [建模资源限制](modeling-resource-limits.md)。

## 父运行与预算

父运行保存 modeling.json、追加 events.jsonl 和有界 payloads，关联每次训练阶段及 EDA 子运行。使用 `bun run modeling inspect --run RUN_DIRECTORY` 检查父运行和未确认子调用。原 EDA 的 manifest.json 与 Notebook 读取方式不变。

总模型尝试及 token 包含建模智能体和 EDA 全部角色/重试；EDA 子额度从父剩余量分配，结果按调用身份只结算一次。默认最多 3 次搜索拟合、1 次最终拟合，最终拟合/预测预留 180 秒；预留属于总任务 900 秒的一部分。未知模型用量导致全任务停止。总墙钟和阶段耗时分列，不能再次相加。

## 建模与定向 EDA

```sh
bun run modeling run --task configs/modeling/synthetic.json
```

此命令调用真实模型，使用配置中的 model_profile/eda_profile；`--model ID` 可同时覆盖两者。建模智能体只有 run_experiment/analyze/finish_modeling 三个动作。分析必须描述候选、疑问、证据需求和结果如何影响选择；随后训练关联已接受的分析身份、来源实验与有效证据。普通运行允许直接训练或无 EDA 完成，协作验收则要求真实走过分析后训练。

每次 EDA 为独立双角色子运行，同次 EDA 内部共享 Notebook；多次调用通过显式文件和结构化结果交接。失败分析只作为诊断，不能引用为成功证据。后续训练变差时保留原最佳实验；平局保留先完成者。

完成动作冻结最佳流水线，在全部允许训练数据上重新拟合，再对外层无标签特征预测。拟合/验证预测/最终预测均独立隔离。最终拟合失败不会降级为验证模型却报告成功。交付保存于父运行 delivery/，不在宿主反序列化模型。

```sh
bun run modeling reproduce --run RUN_DIRECTORY
bun run modeling reproduce --run RUN_DIRECTORY --mode refit
bun run modeling score --run RUN_DIRECTORY --labels-root PRIVATE_DIRECTORY --labels labels.csv
```

reproduce 默认在新容器恢复已保存模型，以 `atol=1e-8, rtol=1e-6` 比对预测；refit 则重新执行冻结流水线的全训练数据拟合及预测。两者均无 LLM 调用，独立保存到 runs/modeling-reproductions，不覆盖原运行。它们不重演分析与实验决策。输入或镜像身份不匹配时拒绝同条件复现。

score 只接受已完成且交付冻结的运行，私有标签 CSV 必须恰为 ID 列和目标列，样本与预测一一对应。结果保存在独立 runs/modeling-scores，搜索不会接收它。内层 RMSE 与外层 RMSE 分列，不用内层自适应分数证明泛化收益。

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

## 候选状态与动作协议 v2

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

## 每次 EDA 的申请、分配与消费

`analyze` 必须包含正整数 `requested_budget:{task_timeout_ms,total_tokens,executions}` 和 `budget_reason`。例如 90,000 毫秒、100,000 token、3 次执行可用于一次聚焦残差检查；额度是否足够还取决于输入长度和模型最大输出，过小可能在模型调用预检时耗尽。

实际额度逐项取申请、配置上限、父剩余量的最小值；时间还须扣除最终交付预留。模型尝试数由宿主按配置和父剩余量分配。`eda_executions` 是整个父任务累计上限，不会每次重置。任一必要维度为零则拒绝动作，超大申请则裁剪，并把 `requested/effective/remaining/limits/clipped` 返回建模智能体。

确定性例子（默认上限，允许两次 EDA）：父剩余 800,000 毫秒时，申请 10,000 毫秒/300 token/3 次执行，实际相同，模型尝试上限 20；假设实际仅用 150 token、3 次模型调用和 2 次执行，则只结算这些消费。随后父剩余 185,001 毫秒，申请 400,000 毫秒/800,000 token/20 次执行，实际为 **5,001 毫秒/400,000 token/8 次执行/20 次模型尝试**。时间保留 180,000 毫秒，父 token 剩余 599,850，EDA token 配置上限 400,000。此例说明分配计算，不保证这么小的首次 token 申请足以发出真实模型请求。

截止时间在父动作接受时固定，包含分析输入准备、双角色切换、模型调用和执行；进入子运行不能重新获得整段时间。同次 EDA 的规划者、执行者和重试共享额度。准备前/准备阶段失败若尚未派发，则记录 `not_started` 和已知零模型消费；派发后无法确认用量则停止父任务。已知子额度耗尽可作为诊断返回，但不能当成证据或自动增加预算。

申请和分配不是预付费用，未用额度不扣除，实际消费按子运行身份幂等结算，并核对角色小计和执行次数。token 是停止阈值：一个已派发响应可能超出额度，全部消费照实记账，后续调用停止，不能宣称严格 token 硬限额。

## 记录兼容与本轮验收

父清单仍为 schema 1，新运行扩展 `candidate_control:{version:1,candidates,applied_sequence}`；提示词为 `modeling-v2`，接受事件为协议 2。inspect 从接受事件归约历史，核对候选快照、实验身份/修复和 EDA 请求/分配/真实原生子配置/消费，显示未确认实验及子结算。快照可落后于中断时已接受日志；已完成运行不得缺失确认结果。未知扩展版本或不一致事实直接拒绝。

现有任务配置无需迁移；旧模型工具参数不能直接用于新的运行。旧父记录没有扩展时输出 `candidate_control: "not_recorded"`，不从自然语言补造状态、不改写原文件，仍支持既有交付复现。原生 EDA schema 不变。

本轮真实验收仅在上文固定开发任务执行 **一次**，保持 900 秒/40 次总尝试/600,000 token 阈值、3 次搜索+1 次最终拟合、180 秒预留，以及一次 EDA 的 20 次尝试/400,000 token/300 秒/10 次执行上限。任务明确要求候选清单、显式 EDA 额度申请、证据关联更新和后续训练。不同额度裁剪与故障修复由可控测试保证，真实模型不强求触发故障或改进成绩。首次报告不可覆盖；失败不自动加跑，若只修验收器则单独保存同一记录的离线复核。结果和实际成本见 `docs/modeling-candidate-budget-validation.md`。
