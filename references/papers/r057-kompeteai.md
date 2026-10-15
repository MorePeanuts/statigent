# KompeteAI: Accelerated Autonomous Multi-Agent System for End-to-End Pipeline Generation for Machine Learning Problems

[返回文献总表](../index.md) · [筛选记录](../screening.md)

## 基本信息

| 字段 | 记录 |
| --- | --- |
| 稳定编号 | R057 |
| 作者 | Stepan Kulibaba; Artem Dzhalilov; Roman Pakhomov; et al. |
| 最早核验年份 | 2025（已核验来源中的最早年份，不保证等于所有早期稿） |
| 本轮采用载体 / 版本 | arXiv:2508.10177v3 |
| 方向 | 建模智能体 |
| 优先级 / 纳入 | P0；纳入参考库 |
| 来源 | 本轮新增 |
| 阅读状态 | L2 定向阅读；未做本地复现 |
| 核验日期 | 2026-10-15 |
| 原文 | [论文主页 / 采用版本](https://arxiv.org/abs/2508.10177v3) |

## 研究问题与方法

将 EDA、特征工程和训练组织为候选树，交替扩展与合并；可以按需追加探索，并利用外部检索与早期评分。 [来源](https://arxiv.org/abs/2508.10177v3)

## 证据与本轮阅读范围

已核查 §3.2.1 和 §3.3.1：EDA 根节点可更新，扩展前可通过函数调用追加数据检查。 [补充来源：方法正文 §3.2.1、§3.3.1](https://arxiv.org/html/2508.10177v3)

L2 表示核查了上述指定章节，不表示逐表复核、完整精读或代码复现。作者报告的结果只用于理解其研究范围，不作为 Statigent 实验结果。

## 与 Statigent 的关系（本次分析）

第二章必须正面比较的近邻，明确否定“首次在建模过程中调用 EDA”的宽泛创新表述。

## 局限与引用边界（本次分析）

动态 EDA 已存在；本课题需验证显式数据认识和实验反馈是否有额外价值。外部检索与评分预测也影响成本。

## 下一步精读

进一步读 EDA 提示词、状态传递和消融，区分架构不同与已经证实的效果差异。

## 写作引用入口

Stepan Kulibaba, Artem Dzhalilov, Roman Pakhomov, et al. KompeteAI: Accelerated Autonomous Multi-Agent System for End-to-End Pipeline Generation for Machine Learning Problems. arXiv:2508.10177v3. [原始条目](https://arxiv.org/abs/2508.10177v3)（访问：2026-10-15）。

这是便于定位的书目草稿，不是已经完成 GB/T 7714 排版的最终条目；使用前从所选版本导出完整作者、文献类型、正式年份、卷页与 DOI。
