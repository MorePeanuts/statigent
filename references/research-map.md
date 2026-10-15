# 面向两章研究的文献脉络

本页是基于首轮阅读的工作性综合，不是论文相关工作正文，也不是已证实的研究贡献。方法设计见 [overview](../docs/overview.md)，阅读状态见 [总表](index.md)。

## 第一章：多步探索、执行状态与角色分工

| 研究问题 | 优先对照的文献 | 已有工作说明了什么 | Statigent 仍需实证回答什么 |
| --- | --- | --- | --- |
| 推理如何连接真实执行？ | [ReAct](papers/r019-react.md)、[CodeAct](papers/r053-codeact.md) | 推理与动作可以交替；代码可以作为可组合动作接口 | 专用 EDA 组织相对通用循环的质量和总成本变化 |
| 多角色交接有什么价值？ | [AutoGen](papers/r052-autogen.md)、[TaskWeaver](papers/r034-taskweaver.md)、[Data Interpreter](papers/r024-data-interpreter.md) | 对话分工、规划和代码执行已有框架支持 | 规划者不接收全部实现历史时，是否仍能可靠决策；所有角色合计成本如何变化 |
| Notebook 状态与增量执行如何影响任务？ | [DatawiseAgent](papers/r032-datawiseagent.md)、[TaskWeaver](papers/r034-taskweaver.md) | 状态延续、逐步执行、反馈修复都已有明确先例 | 相同任务记忆和磁盘复用规则下，持久内核相对每轮新进程是否改善结果或成本 |
| 如何从计算走向探索和报告？ | [InsightPilot](papers/r029-insightpilot.md)、[DS-STAR](papers/r056-ds-star.md)、[DeepAnalyze](papers/r033-deepanalyze.md) | 动作选择、异构资料分析、计划验证及专用模型训练提供不同路线 | 哪些错误来自计划、数据语义、执行、结论解释；专用模型和编排改变需分开 |
| 怎样评价“可信”？ | [InfiAgent-DABench](papers/r003-infiagent-dabench.md)、[DSBench](papers/r004-dsbench.md)、[DAComp](papers/r055-dacomp.md) | 闭式答案、复杂案例问答与开放式报告是不同评估对象 | 保持各自官方口径，额外检查证据可追溯和产物可复现，不混成一个含义不明的成功率 |

**创新边界。** TaskWeaver 的 §4.3 已明确会话内有状态代码执行，DatawiseAgent 的 §3 已明确 Notebook 单元交互与增量执行。因此，本课题不能将“Notebook + 规划执行”本身写成首次提出；更合适的论证是信息交接方式、任务适配与可控消融带来的可验证增量。[TaskWeaver 正文](https://arxiv.org/html/2311.17541v3)、[DatawiseAgent 正文](https://arxiv.org/html/2503.07044v2)

**评价补充。** [DSEval](papers/r026-dseval.md) 支持执行产物检查，[DSAEval](papers/r060-dsaeval.md) 强调多查询上下文，[DataClaw](papers/r064-dataclaw.md) 关注中间里程碑。[InsightBench](papers/r066-insightbench.md) 与 [InsightEval](papers/r063-insighteval.md) 可用于讨论主动洞察，但后者修订前者，不能作为两个独立来源的数据泛化证据。本轮不将这些补充集加入必跑实验。

## 第二章：从流水线搜索到诊断驱动的改进

| 路线 | 代表文献 | 与本课题的联系 | 需要控制的差异 |
| --- | --- | --- | --- |
| 传统模型和流水线优化 | [Auto-WEKA](papers/r007-autoweka.md)、[TPOT](papers/r008-tpot.md)、[ML-Plan](papers/r009-mlplan.md)、[Auto-sklearn 2.0](papers/r006-autosklearn2.md)、[AutoGluon](papers/r005-autogluon.md) | 联合选择、结构搜索、经验和验证反馈早已用于自动化建模 | 模型空间、集成、预算、预计算和硬件 |
| 经验/知识驱动方案生成 | [DS-Agent](papers/r023-ds-agent.md)、[MLCopilot](papers/r044-mlcopilot.md)、[CoMind](papers/r043-comind.md) | 建模想法来自可复用知识，而非只有随机试错 | 案例来源、外部社区、时间截点和目标任务污染 |
| 候选搜索与多路径迭代 | [AIDE](papers/r027-aide.md)、[SELA](papers/r028-sela.md)、[R&D-Agent](papers/r041-rd-agent.md) | 组织不同候选并利用执行反馈改进 | 多轨迹总成本、搜索深度与基础模型 |
| 定向改进 | [MLE-STAR](papers/r042-mle-star.md) | 以组件消融引导具体代码块优化 | 外部检索、组件消融开销与集成；不能与样本误差诊断直接等同 |
| 搜索中追加数据探索 | [KompeteAI](papers/r057-kompeteai.md) | 明确支持动态 EDA 与方案上下文更新 | 其树扩展/合并、RAG 和预测评分不同于当前实现 |
| 诊断推理与经验更新 | [Gome](papers/r058-gome.md) | 结构化反馈指导代码更新，复用成功经验 | 推理模型能力、闭世界协议、多轨迹共享 |
| 学习何时及如何使用诊断工具 | [MLToolBench](papers/r059-mltoolbench.md) | 表明工具接入与有效工具使用是不同问题 | SFT/RL、特权训练信息和合成任务；不能与无训练编排直接比结果 |

**最需要正面比较的近邻。** KompeteAI §3.3.1 已允许扩展候选前调用额外 EDA；Gome 已使用结构化诊断与成功记忆；MLE-STAR 已开展有针对性的组件更新。这些工作使“首次用 EDA 指导建模”“首次根据反馈修订方案”成为过宽表述。当前候选贡献应聚焦在本项目定义的分析发现、模型诊断、实验检验和认识交接如何共同改善最终模型，并用消融验证，而不能仅凭接口命名宣称不同。[KompeteAI 正文](https://arxiv.org/html/2508.10177v3)、[Gome v3](https://arxiv.org/html/2603.01692v3)、[MLE-STAR v3](https://arxiv.org/html/2506.15692v3)

**工具收益需要证据。** MLToolBench 区分未适配模型使用工具、SFT 和 RL，也明确指出工具覆盖率不等于有用性。对本项目的启示是检查 EDA 是否实际产生或改变方案，以及训练验证如何支持或推翻该判断；调用次数只能描述行为，不能单独证明收益。这是本次调研的设计推论。[MLToolBench v2，附录 B](https://arxiv.org/html/2609.36679v2)

## 写作组织与精读顺序

1. **确定问题与评测对象：** R022 → R004 → R003/R055 → R054。区分分析与预测、公开子集与完整基准、作者结果与本地结果。
2. **第一章核心近邻：** R019/R052/R053 → R034 → R032 → R024 → R056。优先整理状态寿命、规划者可见信息、执行反馈和停止规则。
3. **第二章核心近邻：** R005/R006 → R023/R044 → R027/R028/R041 → R042/R057/R058/R059。优先整理数据理解如何产生方案、验证反馈如何改变分析问题。
4. **扩展与边界：** R033/R039/R060/R064/R065。说明模型训练、跨模态、过程评价及表格基础模型等方向为何不直接纳入当前主实验。
5. **基础章节按需写：** Transformer、CoT、通用 Agent 综述和 AutoML 历史只为研究论点服务，不按时间线堆砌全部论文。

P0 仍有部分只完成 L1；优先级与阅读完成度分开。正式主张某方法“没有某机制”前，应继续核查正文、附录和代码，不能把摘要未提及当作不存在。

## 实验解释中需要保留的边界

- **单角色/分角色 × 持久内核/新脚本** 的具体定义仍以项目规格和运行配置为准。原有记忆、磁盘复用与启动开销均可能影响结果，不在文献库另设一套规则。
- 分析和建模费用合计；离线案例库、并行候选、裁判、调试与最终拟合的成本要区分。相同 LLM 预算不保证相同计算投入。
- [TabArena](papers/r054-tabarena.md) 的 Lite 是外层划分缩减，不能假定内层搜索免费；[TabPFN-2.5](papers/r065-tabpfn25.md) 属于表格基础模型，不应混称为 LLM Agent。
- Kaggle 系基准可能共享任务；重复任务、训练污染和外部资料不能作为独立泛化证据。官方排行榜只作背景，不与本地同预算重跑结果混表。

本页不声称已有论文已经验证本课题假设，也不扩大 `main` 中尚待冻结的正式实验名单。
