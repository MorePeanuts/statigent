# Design

## Context

动机与范围见 [proposal.md](proposal.md)。本设计需要同时处理第三方编排、模型记账和预测交付，因此保留独立设计文档。

当前工程的实际接入点与限制：

- `src/evaluation/registry.ts` 仅注册 Statigent EDA、Statigent 建模、确定性建模夹具和离线命令。`container-command.ts` 只支持 text/report，禁止模型配置，且要求用量为 not_applicable；不能通过放宽它来接入联网 Agent。
- `src/models/client.ts` 的 `ModelClient` 支持受控请求、角色消息、工具、模型响应和已知/未知用量；`src/execution/` 已有持久内核与新脚本执行会话，可复用隔离、生命周期和产物收集。
- `src/agent/prompt.ts` 的单角色模式要求 findings、成功执行与 evidence_refs，并非无附加机制的基础 ReAct。共享执行设施不意味着可以直接复用方法身份。
- `src/evaluation/benchmarks/modeling/publication.ts` 已提供 search/final-fit/prediction 等阶段白名单，但 `predictions.ts` 的 v1 清单要求 Statigent 原生模型及实验字段。需要增量支持外部交付，而非伪造这些字段。
- 当前通用计算环境主要为 pandas/numpy/sklearn；TabArena 可选环境用于官方兼容验证，包含单独锁定依赖，不宜直接当 AutoGluon baseline 环境。
- 已有开发清单及数据准备可复用。正式任务资格、重复次数和预算冻结不在本设计范围。

外部依据（2026-10-15 只读核查，版本号/commit 尚未在本变更中安装验证）：

- [ReAct 原论文](https://arxiv.org/abs/2210.03629)定义推理与行动交替，当前方案将其适配到表格任务，明确标为本地实现。
- [AutoGen 0.2 官方接口](https://microsoft.github.io/autogen/0.2/docs/reference/agentchat/conversable_agent/)提供自动回复、人类输入、代码执行和模型配置控制，选用该代双代理 API；不声称复现 DSBench 未核验的原始具体配置。
- [DatawiseAgent 官方仓库](https://github.com/zimingyou01/DatawiseAgent)提供分析和建模配置；其 [Agent 源码](https://github.com/zimingyou01/DatawiseAgent/blob/main/datawiseagent/agents/datawise_agent.py)把模型调用和 Jupyter 执行集中在边界对象上，但含执行器类型断言，适配应采用兼容子类/边界注入，不能只替换一个命令。保留 FST 决策代码。
- [AutoGluon fit 文档](https://auto.gluon.ai/stable/api/autogluon.tabular.TabularPredictor.fit.html)支持时间、CPU、GPU、模型配置和集成控制；预设随版本变化，因此必须保存有效配置，不能只记录 `best_quality` 名称。

## Goals / Non-Goals

**Goals:**

- 四种 baseline 具有独立实现身份，并能进入既有评测计划、记录、评分和比较流程。
- 本项目新增控制逻辑采用 TypeScript；上游 Python 编排原样复用，由薄桥接调用。Python 中自有代码限于协议胶水、第三方边界适配和实际训练/预测。
- 模型与执行器是所有 Agent 共用的权限/记账边界，模型角色和推理流程仍属于各方法。
- 以公开目标协议驱动预测，覆盖七类开发任务形态，而不是为每个基准题号写专门策略。

**Non-Goals:**

- 不建设通用 Agent 插件平台、远程服务或并行调度器；只支持本次四种受信实现。
- 不复刻第三方网页服务，不开放运行时联网安装，不支持本轮 GPU 或预训练表格基础模型下载。
- 不改变本方法的协同机制，不强制 baseline 使用其候选/确认流程；不实现外部 baseline 的自动 refit 复现，首版仅做冻结模型 predict 复现。
- 不增加纯 LLM、其他论文方法、官方排行榜排名或研究显著性结论；不自动执行付费或正式实验。

## Decisions

### 1. 方法与环境清单先于运行

新增 `src/baselines/`，分别注册 `react`、`autogen`、`datawiseagent`、`autogluon` 适配器。方法清单记录实现类型（local-method / upstream-adapted）、版本、论文/代码来源、许可、参数、提示词、边界适配哈希、执行后端和偏离。

AutoGen 使用官方 Microsoft 0.2 代 API 的固定发布版本，不隐式切换到 AG2 或新版 AgentChat。DatawiseAgent 固定完整 commit，依赖源码下载到忽略 Git 的工具目录并校验身份；不引入其评测答案、历史结果或前端服务。自有 wrapper 位于 `python/statigent_baselines/`，上游源码保持原样。两者分别使用 `environments/baselines/<method>/pyproject.toml` 和 `uv.lock`，运行通过 `uv run --frozen --offline`，不得直接使用 Python 可执行文件启动。

运行镜像与编排环境分开。开发主配置使用 CPU 计算镜像，在现有库基础上显式加入 LightGBM、CatBoost、XGBoost，供三个 LLM baseline 和 Statigent 的新比较配置共同使用；既有配置/镜像不改写。AutoGluon 还包含其专用训练依赖，版本差异列在比较清单。所有依赖在构建阶段锁定，缺失时预检拒绝，不在任务期间安装。

具体补丁版本和镜像摘要由实现期的无模型兼容探针确定并提交；这是安装兼容性工作，不允许据测试成绩选择版本。未通过本机架构/锁定依赖探针的方法不能标为就绪。替代方案是共用一个巨大环境，但会污染默认检查并增加版本冲突，故不采用。

### 2. TypeScript 宿主和受信上游 worker 的窄桥接

```text
evaluation plan
      |
      v
baseline host (TypeScript, ledger, permissions)
      |                          |
      | bounded JSONL            +--> model client --> selected provider
      v                          |
trusted upstream worker          +--> isolated execution session
(AutoGen / DatawiseAgent)                |
      |                                 v
      +---- model / execute requests   task files and generated code
```

ReAct 的循环直接位于 TypeScript。AutoGen/DatawiseAgent 的官方编排运行于受信 Python worker，父进程通过双向 JSONL 处理 `model.request`、`execution.execute`、`artifact.read`、`submission.finish` 等固定请求。消息带协议版本、run_id、request_id 和类型；Zod/Python 对应校验器验证边界，单消息及累计日志均有限额，stderr 单独收集。复用现有 framed transport 的概念，不启动通用 HTTP 代理。

worker 只收到经过筛选的任务视图、配置和已授权相对路径，环境白名单不含密钥；工作目录是独立运行目录，不是仓库。只有经核验的编排源码可在宿主运行，模型文本不得变成 worker 的 eval、exec、本地 shell、任意路径读取或类加载。所有模型生成操作都转换为执行请求，真正代码只在容器内执行。worker 自有会话日志由宿主收集并校验。

宿主拒绝请求携带 URL、环境覆盖、可执行程序或镜像等权限字段。允许的产物读请求只访问本次已收集文件，训练/预测阶段访问检查在宿主执行。上游默认模型 SDK 重试/缓存关闭；重试资格与计数由宿主统一控制。所有模型结果由真实父账记录，上游自报数值只用于核对。

DatawiseAgent 通过兼容 `BaseChatModel` 和 Jupyter 执行器的边界子类接入，避免其默认构造器启动本地 Jupyter 或直接访问 Docker；引导、工作区枚举、图片和日志映射均限定本任务。保留官方过滤或规划回退阶段明确发起的历史重放：过滤或规划回退时，只有搜索阶段、执行状态已知、没有在途执行时，才允许以 `post-filter` 或 `plan-rollback` 原因请求宿主重启，记录新的 kernel epoch，清理派生产物并重放已保留历史；重放与普通执行共享额度、截止时间和日志。状态丢失、执行结果未知、取消或冻结后禁止自动恢复/重放，此差异进入方法清单。AutoGen 注入自定义模型客户端和代码执行器。不得以一个原生 Statigent Agent 包装返回值冒充上游执行。

替代方案：向上游直接注入密钥，或把上游及生成代码放入同一联网容器。两者均无法维持项目的凭据与执行隔离边界，故不采用。父进程仍负责模型调用、执行取消、实际容器清理及未知成本停止；worker 正常退出不等于其容器已停止。

### 3. 三种 Agent 的具体配置

| 方法 | 决策与记忆 | 执行及完成 |
| --- | --- | --- |
| ReAct | 一个模型角色，交替选择执行/最终提交，保存同任务历史；无额外规划、笔记或 findings 门槛 | 默认 persistent-kernel，允许任务内文件复用；最终回答/报告或模型 bundle 按公开协议提交 |
| AutoGen | 官方 `AssistantAgent` 与 `UserProxyAgent` 交互；后者 `llm_config=false`、`human_input_mode=NEVER`，无群聊经理 | 默认 fresh-script，任务文件保留；保留原代码块/执行反馈循环，完成标记与公开交付必须同时满足 |
| DatawiseAgent | 官方 FST 与提示词，按分析/建模选择官方配置来源；规划、自调试和过滤开启 | persistent-kernel；原阶段结束后读取明确的最终交付，不额外调用模型润色或补写 |

三种方法只获得相同公开任务、数据及交付说明，不获得本方法的 EDA 报告或智能体工具。分析任务可以直接读取 CSV/工作簿/SQLite；输出报告的图片能力属于执行能力，未配置视觉模型时不反馈图像给决策模型。

所有内部循环上限显式入快照，并受共同模型次数、token 和总时间约束；DatawiseAgent 的原阶段上限可作为默认，不隐式无限增大。上游提示中的联网安装、GPU 和测试文件访问要求由统一环境/输出约束替代，记录为协议适配。统一模型生成参数优先于上游默认值，保留两者差异。

ReAct 复用底层会话、模型客户端和账本，不复用 `runEda` 的研究专属完成门槛。若后续证明某个消融完整配置确实等价，可显式关联同一运行；本次不预设等价。AutoGen 的新脚本与另外两种持久执行的差异属于完整方法比较，不作为单因素证据。

### 4. 共用的外部建模冻结流程

所有 baseline 只读取公开协议允许的外层训练成员；内部搜索、验证与集成可由方法自行组织。已有划分可作为 Agent 的默认内部验证建议，是否使用及原因入记录；不要求上游套用 Statigent 终局确认。模型选择不得读取测试特征/标签，比较配置注明内部验证差异。

三种 Agent 的建模任务要求交付已拟合 bundle 及 `predict.py` 入口；入口接收宿主提供的只读特征路径、输出路径、公开预测 schema，不接收标签。所有模型文件、相对依赖与入口均在搜索结束时冻结。AutoGluon 提交其模型目录与受信预测入口。同任务工作区不可直接成为最终模型：停止搜索进程/内核，校验普通文件、数量、大小与安全路径，复制完整 bundle 到不可变目录，计算每文件哈希及规范目录摘要，然后启动新的预测容器。

预测容器只挂载冻结 bundle、测试特征、公开 schema 及独立输出区；没有训练输入、搜索工作区、LLM 通道和网络。不使用在途搜索内核继续预测，避免后台执行或状态泄露。禁止预测阶段继续 fit；入口是纯加载/预测契约，受信 AutoGluon wrapper 显式保证，生成入口通过可观测调用/文件审计及无训练数据环境检查，不能宣称能证明任意 Python 的数学性质。

模型自行结束或预算停止时，只有此前已明确登记的有效 bundle 才能进入无 LLM 收尾；不能由宿主从任意文件猜测最佳模型。预留预测/冻结时限由同任务总时限扣除，所有方法均在配置中明示，取消/执行未停止不得继续交付。冻结后的预测错误不交给 Agent 修复。

统一使用现有 `ProtocolV2` 校验 ID、目标、类别/正类、数值/概率/前三候选列，再调用 `python/statigent_benchmarks/delivery.py` 的现有导出路径。外层指标及 DSBench RPG 完全不变；评分材料始终在评测侧。

### 5. AutoGluon 作为明确的 CPU AutoML 对照

使用 `TabularPredictor`，首版配置命名 `autogluon-cpu-v1`：以 `best_quality` 为基础，显式覆盖模型集合为 GBM、CAT、XGB、RF、XT、NN_TORCH，保留训练内 bagging/stacking/weighted ensemble；不使用需要外部权重或服务的模型。实际生效参数展开保存。缺少某个声明的训练依赖应预检失败；运行中的模型训练失败按 AutoGluon 实际行为记录，不能把未训练的模型报告为已训练。

`num_gpus=0`，CPU/内存由容器和官方参数共同限制；固定 seed，并如实记录库/平台的非确定性。训练时间上限为任务剩余时间扣除交付预留，容器父截止时间是硬限制，不能只依赖库的软 `time_limit`。不额外套外部 HPO 或 Statigent 确认。

内部指标采用版本化静态映射，外层始终按本项目冻结协议计算：

| 公开任务指标/形式 | 内部训练选择 | 交付规则 |
| --- | --- | --- |
| RMSE、MAE、median absolute error、R² | 对应官方内部指标，经合成样本核验方向/语义 | 原始数值尺度 |
| accuracy、micro-F1 | accuracy；单标签 micro-F1 等价关系单列验证 | 原始合法标签 |
| 二分类 AUC | 对应官方指标 | 按公开类别顺序排列，显式选正类 |
| 发布版本的特殊 RMSLE、SMAPE | 通过自定义 scorer 复用公开指标核心 | 不在评分端暗中截断/变换预测，域外结果按原协议处理 |
| normalized Gini | 自定义 scorer 保留发布公式和并列顺序 | 原协议正类概率 |
| 普通 / inferred-binary log-loss | 自定义 scorer 复用冻结 sklearn 公式与类别推断规则 | 原协议概率及类别身份 |
| ordinal / quadratic kappa | 多分类模型，使用公开 kappa scorer 选择 | 原等级标签；不搜索测试集最优阈值 |
| top3-hit | 自定义 scorer 计算概率前三命中 | 概率降序取三类，同概率按冻结类别顺序 |
| 多标签 mean-target-AUC | 每目标分别训练二分类，沿用上述映射 | 目标顺序固定，禁止其他目标作为特征 |

scorer 适配只调用 `python/statigent_modeling/metrics_v2.py` 的公开纯计算逻辑，不引入基准私有材料或 RPG 参考；对 AutoGluon 内部类别编码做明确逆映射，并使用其实际验证成员顺序。以相同输入差分验证分数、方向和未定义边界，不能仅凭指标同名声称等价。若某个候选在内部验证上产生无定义分数，则记录该候选选择失败，不把 NaN 换成有效值；全部候选失败时单元失败。映射写入源码配置与快照，覆盖当前全部 metric ID，未知指标必须预检拒绝。目标只有一个训练类别、类别不足以输出三个互异候选等结构问题提前诊断，不使用测试类别补齐。未来确需代理指标时只能以预先公布的新配置版本启用并披露，首版不静默回退到 RMSE/accuracy 等代理。

多目标按公开目标顺序串行训练，每次额度为剩余训练时间除以剩余目标数，未用时间可顺延；任务硬截止时间不变。总拟合、所有模型文件和预测都计入同一单元。由固定公式分配预算，不能为七个目标分别给七倍预算。

### 6. 预测清单 v2 与独立 baseline 记录

新增预测清单 `schema_version=2`，保留现有任务、协议、种子、数据、预测和 export 身份字段，以 `producer`、`model_bundle`、通用 `workflow` 表达外部运行。`producer` 包含 adapter/method/version/config_hash/run_id；`model_bundle` 包含目录清单摘要、大小、入口、环境摘要和冻结身份；不要求 `search_best_experiment_id` 或 `selected_experiment_id`。未做确认写明确不适用，复现初始为 not_run。

`readPredictionManifest` 分版本严格解析，归一化为评分所需的公共视图；旧 v1 仍按原 native_model/workflow 校验。评测外层继续 v3，不借此改变旧容器协议。`Submission.native_run` 不塞入假的 Statigent 引用；baseline 记录通过带类型的 producer/交付清单关联，分析方法的 provenance 进入适配器配置快照和单元事件。

baseline 自身保存独立版本的 `baseline.json` 与 `events.jsonl`，绑定运行、模型请求、执行顺序、最终交付和清理。模型文件可能很多，冻结 bundle 使用独立的文件数/总大小限额，不能套用报告 64 文件限制，也不能无限放宽；限额写入预检与快照。

扩展现有 compare/report 显示方法中立字段，保留不适用与未知区别。离线评分只使用冻结预测和原评分材料，不加载模型。新增 `evaluate reproduce` 的 baseline predict 分支：依据不可变生产者记录启动新容器，重新验证 bundle 全文件摘要，生成新复现身份并比较结果。标签/排名精确比较，数值/概率使用预先声明容差，不按结果放宽；不改变原 workflow 为通过。

替代方案是给外部运行伪造 Statigent 实验和确认字段，虽然改动少但会歪曲研究记录，故不采用。当前新清单的兼容范围是“新程序可读旧记录”，不承诺旧程序能读新清单。

### 7. 公平比较与运行配置

三种 LLM baseline 与本方法使用同一模型 profile、数据权限、外层划分、CPU/内存和任务总时限；每个 LLM 方法共享同样的模型尝试/token 阈值。AutoGluon 不需要模型 profile，LLM 用量不适用，计算预算仍受相同任务上限约束。记录实际资源与依赖差异，不以固定 API 次数强制 AutoML 消耗虚构预算。

开发配置分别覆盖三套分析基准与两套建模基准，每个基准仍是一份单独计划，不改变现有调度结构。总预算预先覆盖计划完整矩阵；仍保留 reduced、not_run 和 unknown 语义。公共数据准备、单元执行/训练、评委评分与独立复现分别记账，父账不重复累加子项。既有正式资格与同源审计不因 baseline 通过而自动改变。

### 8. 验收分层与具体范围

1. 快速测试：协议、参数、阶段权限、账本、目标映射、目录身份、新旧清单和比较缺失行，使用受控响应及小型合成数据；不要求可选上游环境，不调用 API。
2. 可选上游探针：安装锁定环境后，实际导入 AutoGen/DatawiseAgent，使用 mock model/executor 验证角色及阶段；AutoGluon 使用小型合成数据真实 fit/load/predict。探针检查不能只 mock 掉整个上游方法。
3. Docker 集成：三种 Agent 实际上游/本地循环加受控模型，覆盖文本、SQLite 报告、工作簿；四种建模方法覆盖普通回归/二分类/多分类与特殊目标，验证冻结后预测和独立复现。加入网络/密钥/测试特征哨兵、取消、超时、目录篡改和 worker 异常退出。
4. 真实开发冒烟：默认生成范围和预检，不自动执行付费。分析每种方法在三个已有基准开发清单各选一项，共 9 单元；建模复用已冻结 10 题开发集合（七种形态），三种 Agent 共 30 单元，AutoGluon 10 单元。允许操作者显式选择较小 scope，覆盖状态如实记录；任务选择在首次模型调用前按已有清单固定，预算在配置提交时明确，不以本提案代替付费授权。
5. 文档分别报告每层是否运行/通过；真实方法出错保留失败。只有代码、零付费验收及入口齐备可称软件接入完成，付费未验收不得称实验就绪。后续正式预实验和任务冻结另行进行。

## Risks / Trade-offs

- [DatawiseAgent 的执行器耦合与 few-shot 模板] → 对模型/执行/工作区边界做兼容探针；只保留不含本次任务答案的通用引导示例，来源和任何移除均披露；不重写 FST 来降低接入难度。
- [共享环境限制与上游原始设置不同] → 明示 CPU、无联网安装、依赖和阶段化测试输入差异，将结果称为统一协议下的复现；不与论文原分数混算。
- [AutoGluon scorer 的编码、符号和未定义边界不一致] → 与公开指标核心进行普通/并列/边界样本差分，缺少语义映射时拒绝，禁止悄悄换成较容易优化的代理指标。
- [受限预测不等于任意 Python 的形式化无拟合证明] → 关闭决策/训练工具、隔离训练数据和搜索状态、校验冻结入口与模型身份，测试常见 fit 调用和写入违规；审计报告不夸大保证。
- [AutoGluon 大模型目录、序列化依赖与资源软上限] → 独立文件额度、冻结目录全量身份、独立环境加载验证和容器硬截止时间；不在评分进程加载模型。
- [模型客户端兼容性和供应商推理历史字段] → 宿主保留原协议语义并验证多轮历史；不支持的参数在预检/边界明确拒绝，不丢字段后冒称相同配置。
- [方法成本和成功率来自不同版本或失败复测] → 运行身份不可变，复测另建 scope，报告不合并成一次正式实验；未知用量保留。

## Migration Plan

1. 先加入来源/环境清单与新协议，旧配置默认行为不变；以协议和来源探针固定依赖。
2. 落地宿主桥接与新预测清单的读写/评分，保留旧路径；再逐一注册四种 baseline。
3. 加入共同计算镜像与新的开发比较配置；已有历史镜像/配置/结果不改写。
4. 完成快速、上游和 Docker 验收，同步 `docs/overview.md`、`docs/benchmark.md`、评测/运行文档及独立 baseline 验收记录。
5. 真实冒烟仅按后续明确授权的 scope 执行；准备齐全但未跑的层次标记未运行。正式实验不自动开始。

回退时停止选择新 baseline/新清单写入即可，已有 Statigent 与离线命令入口继续工作；保留已产生的新记录及读取器，禁止删除或降级改写历史。

## Open Questions

- 三个可选上游环境在本机架构上可共同复现的精确补丁版本/依赖组合，需要无模型安装探针锁定；方法代际、隔离方式和上述行为契约已确定。
- 真实开发冒烟的最终模型 profile、单元预算和实际执行批次由开发配置预览及后续授权确定，不能据结果扩容或换题；不阻碍先完成软件实现与零付费验收。

2026-10-15 用户确认：本次以现有冻结协议和基准为范围，只支持单目标回归及多标签多目标；多输出回归另列协议扩展，不改变当前评分。普通 log-loss 使用公开核心自定义 scorer，避免 AutoGluon 内置概率截断与冻结 sklearn 公式的边界差异。
