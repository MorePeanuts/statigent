# 首轮检索与核验记录

日期：2026-10-15。项目基线：`main` / `1392fc3`。此为面向具体课题的定向调研，**不是系统综述或穷尽式检索**，没有注册 PRISMA 流程，也不报告未经统计的候选命中总数。

## 范围与步骤

先阅读 main 的研究目标、两章方法和基准协议，再以用户 51 篇种子文献做题名/作者精确检索。沿项目已有相关工作线索补查 Notebook 执行、定向 EDA、建模诊断和当前主基准；再补查 2025–2026 的新方法和评价视角。截止日期是本轮检索日期，不保证检索引擎已索引所有新发表研究。

| 检索组 | 代表性实际查询 / 直接核验 | 目的 |
| --- | --- | --- |
| 原列表校验 | 完整题名 + 第一作者；`DatawiseAgent notebook`；`Benchmarking Data Science Agents Zhang Jiang` | 消歧、正式题名、作者和首发年 |
| 出版版本 | `Auto-Sklearn 2.0 JMLR`；`DS-Agent site:proceedings.mlr.press`；`MatPlotAgent site:aclanthology.org/2024.findings-acl` | 优先定位正式发表记录 |
| 执行与规划 | `TaskWeaver arxiv`；`CodeAct Executable Code Actions`；`AutoGen 2308.08155` | 查找状态执行与通用角色组织的先例 |
| 建模近邻 | `KompeteAI`；`Gome 2603.01692`；`MLToolBench 2609.36679`；`MLE-STAR Nam Yoon` | 查找数据理解和诊断驱动改进机制 |
| 新近评估 | `DSAEval 2601.13591`；`InsightEval data analysis`；`data science agents 2026 notebook exploratory analysis benchmark` | 多查询、洞察和过程评价，检出 DataClaw |
| 主实验来源 | `DAComp benchmark`；`TabArena benchmark` | 补齐现有项目采用但种子清单缺失的来源 |

除上述代表查询外，逐项题名与作者查询用于核验原清单；笔记中的原文链接是逐条证据入口，不保存搜索引擎临时结果编号。搜索摘要用于发现，最终描述以 arXiv、会议论文集、出版商、作者机构记录或作者官方仓库为依据，不采用自动论文解读站的结论。

## 阅读深度

| 级别 | 本轮数量 | 本轮实际完成 |
| --- | --- | --- |
| L1 摘要初读 | 58 | 一手元数据和摘要/正式发表页；适合初筛，不承诺逐条验证实验结论 |
| L2 定向阅读 | 8 | 在 L1 基础上核查下表特定方法/协议章节 |
| 全文精读 / 代码复现 | 0 | 本轮未做，不把文档建档当作复现完成 |

| 文献 | 定向阅读位置 | 支持的具体判断 |
| --- | --- | --- |
| [DatawiseAgent](papers/r032-datawiseagent.md) | §3.1–3.3 | Notebook 单元表示、FST 与增量执行已有明确设计 |
| [TaskWeaver](papers/r034-taskweaver.md) | §4.3 及 Stateful Execution 示例 | 同一会话保留执行状态与变量 |
| [MLE-STAR](papers/r042-mle-star.md) | §3.1–3.4 | 检索初始化、组件消融、定向代码块修订 |
| [TabArena](papers/r054-tabarena.md) | 正文与附录 A.4 | 初始 Lite 保留数据集，只减少外层 fold |
| [DAComp](papers/r055-dacomp.md) | §2.4、表 2 | 总任务 210，DA 子集 100；分析和工程评分不同 |
| [KompeteAI](papers/r057-kompeteai.md) | §3.2.1、§3.3.1 | EDA 状态可更新，候选扩展前可追加探索 |
| [Gome](papers/r058-gome.md) | §3.2、§4.3、Limitations | 层次验证、诊断/记忆/多轨迹消融及模型能力依赖 |
| [MLToolBench](papers/r059-mltoolbench.md) | 摘要、附录 B.1/B.2 | 匹配训练比较、动作奖励与调用统计的解释边界 |

## 版本冲突与尚待补核

- **Reflexion：** arXiv v4 与 NeurIPS 正式版作者表不同，本库采用 [NeurIPS 正式版](https://proceedings.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html)。
- **InfiAgent-DABench：** [ICML 正式摘要](https://proceedings.mlr.press/v235/hu24s.html) 为 603 题、124 CSV；项目采用的公开 validation 为 257 题、52 CSV。两种数字表达不同范围，不直接互相覆盖。
- **DatawiseAgent：** 采用 [EMNLP 正式题名](https://aclanthology.org/2025.emnlp-main.58/)，保留其与早期 arXiv 的题名和作者拼写差异；定稿完整作者表按正式版。
- **JarviX：** [Anthology 页](https://aclanthology.org/2023.emnlp-industry.59/) 与其 PDF 的作者顺序不一致；笔记显式记录，未自行推断勘误结果。
- **DS-STAR：** [v4](https://arxiv.org/abs/2509.21825v4) 是 2026 修订题名，新增作者和开放式研究报告评价，不与 2025 旧摘要混用。
- **Tool Learning：** 已找到作者机构的 DOI 与在线日期；ACM DOI 页本轮返回错误，卷期年份与在线年份仍需区分。保持可核验 arXiv 为采用版本，另附 [作者机构记录](https://researchportal.hkust.edu.hk/en/publications/tool-learning-with-foundation-models/)。
- **MetaGPT：** [OpenReview 入口](https://openreview.net/forum?id=VtmBAGCN7o) 本轮触发浏览器验证。暂按 arXiv 记录，不把其他论文的参考文献当作正式作者表核验。
- 对仍仅采用 arXiv 的条目，本轮未承诺全部找齐后续期刊/会议版本。定稿前按 DOI/arXiv 关联关系补核；每篇笔记的“采用版本”是引用边界。

未下载论文全文集合、数据集或模型；未运行付费 API、基准或复现实验。网页可访问性仅代表本轮实际获取情况，不保证所有外链长期可达。
