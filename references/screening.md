# 原始清单筛选与书目校正

日期：2026-10-15。原始 51 篇逐项保留处置记录；“暂缓”只指当前论文主线，不表示质量差或永久删除。所有条目都有独立 Markdown 笔记。

[文献总表](index.md) · [检索方法](search-log.md)

## 纳入原则

优先支持两个研究章节：有状态多步 EDA 与规划/执行信息分离；数据理解、模型诊断和训练验证的持续协同。保留必要的 LLM/Agent/AutoML 基础文献及实际使用基准。对纯软件开发、NAS、质性访谈和重复综述收缩篇幅。新文献的纳入不更改现有实验方案。

## 原单逐项处置

| 原编号 | 文献 / 笔记 | 处置 | 理由 | 校正 / 核验边界 |
| --- | --- | --- | --- | --- |
| 1 | [A Survey on Code Generation with LLM-based Agents](papers/r001-codegen-survey.md) | 保留 P2 | 作为执行者代码生成、重试与工具集成的背景材料；数据科学方法仍引用原始论文。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 2 | [Multi-Agent Data Visualization and Narrative Generation](papers/r002-visual-narrative.md) | 暂缓 | 与报告交付相邻，但当前课题重点是分析正确性和预测质量，因此暂缓主线引用。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 3 | [InfiAgent-DABench: Evaluating Agents on Data Analysis Tasks](papers/r003-infiagent-dabench.md) | 保留 P0 | 第一章客观计算正确性的核心来源，可与开放式报告评价互补。 | 改用 ICML 2024 正式版；显式区分全文基准规模与公开 validation 子集。 |
| 4 | [DSBench: How Far Are Data Science Agents from Becoming Data Science Experts?](papers/r004-dsbench.md) | 保留 P0 | 为两个独立章节提供任务分类依据；同一基准的两部分并非配对协同实验。 | 首发 2024，当前采用 v3（2025）；不能将修订年当首发年。 |
| 5 | [AutoGluon-Tabular: Robust and Accurate AutoML for Structured Data](papers/r005-autogluon.md) | 保留 P0 | 第二章必须面对的强无 LLM 参照，帮助判断收益来自数据理解还是已有模型库。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 6 | [Auto-Sklearn 2.0: Hands-free AutoML via Meta-Learning](papers/r006-autosklearn2.md) | 保留 P1 | 解释传统 AutoML 已能利用历史经验与验证反馈，不应写成只能盲目调参。 | 改用 JMLR 2022 正式版，预印本首发 2020。 |
| 7 | [Auto-WEKA: Combined Selection and Hyperparameter Optimization of Classification Algorithms](papers/r007-autoweka.md) | 保留 P1 | 用于第二章 AutoML 演进背景，说明联合选择与优化的经典问题定义。 | 保留原单 KDD 2013 线索；当前核验的 arXiv 首发为 2012，会议卷页待正式页核对。 |
| 8 | [TPOT: A Tree-Based Pipeline Optimization Tool for Automating Machine Learning](papers/r008-tpot.md) | 保留 P1 | 提供流水线结构搜索的传统路线，便于与 SELA、AIDE 的代码或流程搜索比较。 | 2016 workshop 与 2019 书章为不同出版版本；当前主链接为书章。 |
| 9 | [ML-Plan: Automated machine learning via hierarchical planning](papers/r009-mlplan.md) | 保留 P1 | 提醒“规划用于 AutoML”有早期文献基础；本课题需说明语义分析如何影响计划。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 10 | [A Survey of Large Language Models](papers/r010-llm-survey.md) | 保留 P1 | 论文基础章节可按需引用，不把其当作本系统设计有效性的实验证据。 | arXiv 首发 2023，原单 2024 可能指修订版。 |
| 11 | [Attention Is All You Need](papers/r011-transformer.md) | 保留 P1 | 用于解释大模型架构基础，篇幅宜短，与本研究工程贡献分开。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 12 | [Chain-of-Thought Prompting Elicits Reasoning in Large Language Models](papers/r012-cot.md) | 保留 P1 | 作为规划推理背景，并与 ReAct 的外部执行反馈区分。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 13 | [Reflexion: Language Agents with Verbal Reinforcement Learning](papers/r013-reflexion.md) | 保留 P1 | 为第二章经验笔记和认知修订提供邻近依据。 | 改用 NeurIPS 2023 正式作者表（5 人，第三作者 Ashwin Gopinath）；原单及 arXiv v4 含 Edward Berman，不能混用版本。 |
| 14 | [The Rise and Potential of Large Language Model Based Agents: A Survey](papers/r014-rise-agents-survey.md) | 暂缓 | 与 R015 和统计数据科学综述重叠，暂缓以控制背景章节篇幅。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 15 | [A Survey on Large Language Model based Autonomous Agents](papers/r015-autonomous-agents-survey.md) | 保留 P1 | 选作通用智能体背景主综述，与领域综述 R022 分工。 | 已补核 Springer 正式页：2024，volume 18，article 186345；arXiv 首发 2023。 |
| 16 | [Large Language Model Agent: A Survey on Methodology, Applications and Challenges](papers/r016-agent-methodology-survey.md) | 暂缓 | 保留可追溯记录；当前用 R015 和 R022 即可建立背景，暂缓重复引用。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 17 | [Tool Learning with Foundation Models](papers/r017-tool-learning.md) | 保留 P1 | 解释把计算交给 Python、把决策交给模型的背景依据。 | arXiv 首发 2023；作者机构记录 DOI 10.1145/3704435 和 2024-12-24 在线日期。原单 2025 可涉及卷期年，ACM 页面本轮访问失败，最终卷期年待核，暂采用 arXiv。 |
| 18 | [MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework](papers/r018-metagpt.md) | 保留 P2 | 用于角色分工和产物协议背景，但数据科学讨论优先引用 Data Interpreter。 | 原单把 ICLR 会议年写为 2023；需与通常引用的 ICLR 2024 正式版分开。本轮 OpenReview 验证页阻断，暂采用可核验的 arXiv 版本，不混入未核对的正式作者表。 |
| 19 | [ReAct: Synergizing Reasoning and Acting in Language Models](papers/r019-react.md) | 保留 P0 | 两章通用单角色基线的来源，有助于分离工具反馈与角色拆分的贡献。 | 采用 ICLR 2023 camera-ready；预印本首发 2022。 |
| 20 | [ChatDev: Communicative Agents for Software Development](papers/r020-chatdev.md) | 暂缓 | 与当前表格分析和预测主线较远，暂缓；角色组织背景已有 MetaGPT 与 AutoGen。 | 首发 2023；原单 ACL 2024 正式卷页尚未补核。 |
| 21 | [Experiential Co-Learning of Software-Developing Agents](papers/r021-experiential-colearning.md) | 暂缓 | 当前不研究跨任务经验库，暂缓；任务内认知更新优先对照 Reflexion 与 Gome。 | 首发 2023；原单 ACL 2024 正式卷页尚未补核。 |
| 22 | [A Survey on Large Language Model-based Agents for Statistics and Data Science](papers/r022-statistics-agents-survey.md) | 保留 P0 | 领域综述首选入口，衔接两章任务定义、统计可靠性与系统设计。 | 已有 2025 The American Statistician 正式在线发表；不再仅标 arXiv 2024。 |
| 23 | [DS-Agent: Automated Data Science by Empowering Large Language Models with Case-Based Reasoning](papers/r023-ds-agent.md) | 保留 P0 | 第二章历史经验辅助建模的重要参照，说明方案并非仅来自模型固有知识。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 24 | [Data Interpreter: An LLM Agent for Data Science](papers/r024-data-interpreter.md) | 保留 P0 | 两章均高度相关；写作需与其动态任务组织和渐进执行比较。 | 正式版为 Findings ACL 2025；预印本首发 2024。 |
| 25 | [MLAgentBench: Evaluating Language Agents on Machine Learning Experimentation](papers/r025-mlagentbench.md) | 保留 P1 | 为实验闭环与长程失败分析提供经典评测依据。 | 改用 ICML 2024 正式版；arXiv 首发 2023。 |
| 26 | [Benchmarking Data Science Agents](papers/r026-dseval.md) | 保留 P1 | 支持把可执行结果、状态完整性与自然语言答案分开评价。 | 已定位 ACL 2024 正式版，基准名称为 DSEval。 |
| 27 | [AIDE: AI-Driven Exploration in the Space of Code](papers/r027-aide.md) | 保留 P0 | 第二章搜索路线的重要对照：分数驱动候选选择与证据驱动诊断应分别讨论。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 28 | [SELA: Tree-Search Enhanced LLM Agents for Automated Machine Learning](papers/r028-sela.md) | 保留 P0 | 比一般软件搜索更接近表格建模，可用于讨论搜索多样性。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 29 | [InsightPilot: An LLM-Empowered Automated Data Exploration System](papers/r029-insightpilot.md) | 保留 P1 | 第一章自动探索的早期直接相关系统，也为第二章分析动作选择提供背景。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 30 | [JarviX: A LLM No code Platform for Tabular Data Analysis and Optimization](papers/r030-jarvix.md) | 保留 P2 | 作为分析与预测结合的早期旁证保留，不能声称本项目首次将 EDA 与 AutoML 连接。 | Anthology 第三作者为 Tsungyao Chang，PDF 第三作者为 Wenqi Lin；定稿以 PDF/作者勘误为准，当前显式保留冲突。 |
| 31 | [Data-Copilot: Bridging Billions of Data and Humans with Autonomous Workflow](papers/r031-data-copilot.md) | 保留 P1 | 与本课题的代码执行和工具封装相关，可讨论预计算与任务内探索的取舍。 | 当前采用 v8（2025），第三作者为 Zeqi Tan；原单为早期作者顺序，不与最新版混拼。 |
| 32 | [DatawiseAgent: A Notebook-Centric LLM Agent Framework for Adaptive and Robust Data Science Automation](papers/r032-datawiseagent.md) | 保留 P0 | 第一章最接近的研究之一：Notebook 与增量执行已有明确先例，需具体检验角色分离和上下文交接的增量价值。 | 采用 EMNLP 2025 正式题名，增加 Adaptive and Robust；Huamin（正式页/PDF）与 Huaming（arXiv）拼写有差异，完整书目按正式版。 |
| 33 | [DeepAnalyze: Agentic Large Language Models for Autonomous Data Science](papers/r033-deepanalyze.md) | 保留 P1 | 补充从工作流编排走向模型训练的路线，说明研究对象不仅是提示词框架。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 34 | [TaskWeaver: A Code-First Agent Framework](papers/r034-taskweaver.md) | 保留 P0 | 直接约束第一章创新表述：规划分工与有状态执行均有先例，贡献应落在特定信息边界和可控消融。 | arXiv 首发 2023，而非原单标注的 2024 首发。 |
| 35 | [LAMBDA: A Large Model Based Data Agent](papers/r035-lambda.md) | 保留 P1 | 可对照角色职责：本项目执行者自行修复，不设置独立 Debugger。 | arXiv 首发 2024，而非原单标注的 2025 首发；正式发表状态未在本轮补齐。 |
| 36 | [MatPlotAgent: Method and Evaluation for LLM-Based Agentic Scientific Data Visualization](papers/r036-matplotagent.md) | 保留 P2 | 用于第一章图表作为证据的辅助讨论；不作为完整 EDA 能力的替代。 | 已补核 Findings ACL 2024 正式页及 11789–11804 页码。 |
| 37 | [Can Large Language Models Serve as Data Analysts? A Multi-Agent Assisted Approach for Qualitative Data Analysis](papers/r037-qualitative-analysts.md) | 暂缓 | 当前以结构化数据探索和预测为主，故暂缓；题名中的 Data Analysts 不足以证明任务匹配。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 38 | [AutoKaggle: A Multi-Agent Framework for Autonomous Data Science Competitions](papers/r038-autokaggle.md) | 保留 P1 | 建模任务组织和工程可靠性的直接相关工作。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 39 | [MLZero: A Multi-Agent System for End-to-end Machine Learning Automation](papers/r039-mlzero.md) | 保留 P1 | 说明端到端建模代理可覆盖数据理解、工具知识和跨模态处理。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 40 | [AutoML-GPT: Automatic Machine Learning with GPT](papers/r040-automl-gpt.md) | 保留 P2 | 作为 LLM 建模代理的历史过渡文献，不用作当前最强基线。 | 明确采用 Zhang 等 2305.02499，避免与同名 AutoML-GPT（Tsai 等）混淆。 |
| 41 | [R&D-Agent: Automating Data-Driven AI Solution Building Through LLM-Powered Automated Research, Development, and Evolution](papers/r041-rd-agent.md) | 保留 P0 | 与研究决策/实验执行分工及反馈迭代紧密相关，第二章应明确对照。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 42 | [MLE-STAR: Machine Learning Engineering Agent via Search and Targeted Refinement](papers/r042-mle-star.md) | 保留 P0 | 与“反馈决定下一步优化方向”直接相关，不能将定向改进本身当作新贡献。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 43 | [CoMind: Towards Community-Driven Agents for Machine Learning Engineering](papers/r043-comind.md) | 保留 P1 | 作为开放知识建模路线保留，提示案例检索和社区资料可能改变任务难度。 | 当前题名增加 CoMind；作者主页列 ICLR 2026，早期原单无此前缀。 |
| 44 | [MLCopilot: Unleashing the Power of Large Language Models in Solving Machine Learning Tasks](papers/r044-mlcopilot.md) | 保留 P1 | 与 DS-Agent 一起说明经验驱动方案生成的研究路线。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 45 | [MLE-bench: Evaluating Machine Learning Agents on Machine Learning Engineering](papers/r045-mle-bench.md) | 保留 P1 | 用来理解 AIDE、MLE-STAR、Gome 等论文的结果口径。 | arXiv 首发 2024，而非原单 2025 首发。 |
| 46 | [MLGym: A New Framework and Benchmark for Advancing AI Research Agents](papers/r046-mlgym.md) | 保留 P2 | 用于实验环境和研究代理评测背景。 | 已有 COLM 2025 会议版，本轮主引用采用该版。 |
| 47 | [MLE-Dojo: Interactive Environments for Empowering LLM Agents in Machine Learning Engineering](papers/r047-mle-dojo.md) | 保留 P2 | 为训练/评测分离、工具结果验证和可复现环境提供参照。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 48 | [SWE-bench: Can Language Models Resolve Real-World GitHub Issues?](papers/r048-swe-bench.md) | 暂缓 | 当前不研究仓库修复，暂缓；本课题应使用数据分析和建模基准。 | arXiv 首发 2023，原单 ICLR 2024 是正式发表年线索。 |
| 49 | [Data Analysis in the Era of Generative AI](papers/r049-generative-data-analysis.md) | 保留 P1 | 用于绪论和研究动机，连接自动化能力、结果可解释性与用户需求。 | 题名、作者简写与原文入口已核验；完整正式书目仍按采用版本导出。 |
| 50 | [DARTS: Differentiable Architecture Search](papers/r050-darts.md) | 暂缓 | 当前不研究 NAS，暂缓以避免把 AutoML 综述扩展到无关模型架构。 | 预印本首发 2018，原单 2019 不是首发年。 |
| 51 | [Regularized Evolution for Image Classifier Architecture Search](papers/r051-regularized-evolution.md) | 暂缓 | 属于 NAS 历史路线，当前暂缓；传统流水线搜索已有 TPOT 可用。 | 预印本首发 2018，AAAI 2019 已由 arXiv Comments 核验。 |

## 新增文献及补充原因

| ID | 文献 / 笔记 | 补充原因 |
| --- | --- | --- |
| R052 | [AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation](papers/r052-autogen.md) | 补齐原清单缺失的通用多代理参照；代码助手加非 LLM 执行器可构成明确基线。 |
| R053 | [Executable Code Actions Elicit Better LLM Agents](papers/r053-codeact.md) | 直接支持代码作为可组合工具接口的设计背景，与 Notebook 执行研究相邻。 |
| R054 | [TabArena: A Living Benchmark for Machine Learning on Tabular Data](papers/r054-tabarena.md) | 第二章受控表格预测实验的核心来源；项目使用版本和 system 接口由现有协议固定。 |
| R055 | [DAComp: Benchmarking Data Agents across the Full Data Intelligence Lifecycle](papers/r055-dacomp.md) | 第一章开放业务分析主基准的来源，补齐原清单遗漏。 |
| R056 | [DS-STAR: Data Science Agent for Solving Diverse Tasks across Heterogeneous Formats and Open-Ended Queries](papers/r056-ds-star.md) | 第一章重要近期参照，连接多文件证据、规划修订与报告交付。 |
| R057 | [KompeteAI: Accelerated Autonomous Multi-Agent System for End-to-End Pipeline Generation for Machine Learning Problems](papers/r057-kompeteai.md) | 第二章必须正面比较的近邻，明确否定“首次在建模过程中调用 EDA”的宽泛创新表述。 |
| R058 | [Reasoning as Gradient: Scaling MLE Agents Beyond Tree Search](papers/r058-gome.md) | 与模型反馈驱动诊断、经验更新高度接近，是第二章贡献边界的首要近期文献。 |
| R059 | [MLToolBench: Learning Tool-Augmented Agents for Machine Learning Development](papers/r059-mltoolbench.md) | 直接提醒“提供 EDA 工具”不等于“能有效使用”；支持研究工具接入之外的决策机制。 |
| R060 | [DSAEval: Evaluating Data Science Agents on a Wide Range of Real-World Data Science Problems](papers/r060-dsaeval.md) | 补充持续上下文和交互任务的近期评价视角，适合讨论 Notebook 状态的实际需求。 |
| R061 | [DataSciBench: An LLM Agent Benchmark for Data Science](papers/r061-datascibench.md) | 补充结果文件与代码行为的客观检验思想。 |
| R062 | [DABstep: Data Agent Benchmark for Multi-step Reasoning](papers/r062-dabstep.md) | 有助于讨论多文件、多步推理与标准答案评价，作为外部扩展参考。 |
| R063 | [InsightEval: An Expert-Curated Benchmark for Assessing Insight Discovery in LLM-Driven Data Agents](papers/r063-insighteval.md) | 第一章开放洞察评价的近期补充，提示参考答案质量也需要审计。 |
| R064 | [DataClaw: A Process-Oriented Agent Benchmark for Exploratory Real-World Data Analysis](papers/r064-dataclaw.md) | 补充第一章过程证据：最终答案之外可观察部分进展，但不替代主任务分数。 |
| R065 | [TabPFN-2.5: Advancing the State of the Art in Tabular Foundation Models](papers/r065-tabpfn25.md) | 补充传统 AutoML 之外的近期强表格学习路线，避免把“无 Agent”简单等同于旧式调参。 |
| R066 | [InsightBench: Evaluating Business Analytics Agents Through Multi-Step Insight Generation](papers/r066-insightbench.md) | 与闭式问答形成互补，为自主提出分析问题提供评价背景。 |
