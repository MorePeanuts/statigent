# TabArena: A Living Benchmark for Machine Learning on Tabular Data

[返回文献总表](../index.md) · [筛选记录](../screening.md)

## 基本信息

| 字段 | 记录 |
| --- | --- |
| 稳定编号 | R054 |
| 作者 | Nick Erickson; Lennart Purucker; Andrej Tschalzev; et al. |
| 最早核验年份 | 2025（已核验来源中的最早年份，不保证等于所有早期稿） |
| 本轮采用载体 / 版本 | NeurIPS 2025 Datasets and Benchmarks（spotlight）；arXiv:2506.16791v4 |
| 方向 | 自动机器学习 |
| 优先级 / 纳入 | P0；纳入参考库 |
| 来源 | 本轮新增 |
| 阅读状态 | L2 定向阅读；未做本地复现 |
| 核验日期 | 2026-10-15 |
| 原文 | [论文主页 / 采用版本](https://arxiv.org/abs/2506.16791v4) |

## 研究问题与方法

建立持续维护的表格学习基准，统一数据与模型实现，分析验证、调参和集成对排名的影响。 [来源](https://arxiv.org/abs/2506.16791v4)

## 证据与本轮阅读范围

已核查附录 A.4：初始 Lite 保留全部数据集但仅一个外层 fold；论文仍讨论模型配置搜索。 [补充来源：正文及附录 A.4 TabArena-Lite](https://arxiv.org/html/2506.16791v4)

L2 表示核查了上述指定章节，不表示逐表复核、完整精读或代码复现。作者报告的结果只用于理解其研究范围，不作为 Statigent 实验结果。

## 与 Statigent 的关系（本次分析）

第二章受控表格预测实验的核心来源；项目使用版本和 system 接口由现有协议固定。

## 局限与引用边界（本次分析）

Lite 不代表只有很少数据或免除内层开销；living leaderboard 会更新，不能替代同预算本地重跑。

## 下一步精读

精读数据整理和验证过拟合分析；锁定版本、任务、划分和 model/system 比较口径。

## 写作引用入口

Nick Erickson, Lennart Purucker, Andrej Tschalzev, et al. TabArena: A Living Benchmark for Machine Learning on Tabular Data. arXiv:2506.16791v4. [原始条目](https://arxiv.org/abs/2506.16791v4)（访问：2026-10-15）。

这是便于定位的书目草稿，不是已经完成 GB/T 7714 排版的最终条目；使用前从所选版本导出完整作者、文献类型、正式年份、卷页与 DOI。
