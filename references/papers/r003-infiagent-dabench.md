# InfiAgent-DABench: Evaluating Agents on Data Analysis Tasks

[返回文献总表](../index.md) · [筛选记录](../screening.md)

## 基本信息

| 字段 | 记录 |
| --- | --- |
| 稳定编号 | R003 |
| 作者 | Xueyu Hu; Ziyu Zhao; Shuang Wei; et al. |
| 最早核验年份 | 2024（已核验来源中的最早年份，不保证等于所有早期稿） |
| 本轮采用载体 / 版本 | ICML 2024, PMLR 235:19544–19572 |
| 方向 | 数据分析 |
| 优先级 / 纳入 | P0；纳入参考库 |
| 来源 | 用户初始列表 #3 |
| 阅读状态 | L1 摘要初读；未做本地复现 |
| 核验日期 | 2026-10-15 |
| 原文 | [论文主页 / 采用版本](https://proceedings.mlr.press/v235/hu24s.html) |

**书目校正：** 改用 ICML 2024 正式版；显式区分全文基准规模与公开 validation 子集。

## 研究问题与方法

把数据分析问题规范为可自动评分的闭式答案，允许智能体与执行环境交互。 [来源](https://proceedings.mlr.press/v235/hu24s.html)

## 证据与本轮阅读范围

正式 ICML 版本摘要为 603 题、124 份 CSV；公开 validation 子集为 257 题、52 份 CSV，项目采用后者，不能混称完整规模。 [补充来源：预印本（与正式版分开）](https://arxiv.org/abs/2401.05507)

L1 表示已核验一手书目与摘要/正式页；尚未逐节核查正文、表格与代码。作者报告的结果只用于理解其研究范围，不作为 Statigent 实验结果。

## 与 Statigent 的关系（本次分析）

第一章客观计算正确性的核心来源，可与开放式报告评价互补。

## 局限与引用边界（本次分析）

它覆盖特定任务与输出格式，不能单独测量开放洞察质量；公开集与隐藏测试需分清。

## 下一步精读

精读评分与数据划分，并对照项目冻结的官方实现，不沿用论文分数作为本地结果。

## 写作引用入口

Xueyu Hu, Ziyu Zhao, Shuang Wei, et al. InfiAgent-DABench: Evaluating Agents on Data Analysis Tasks. ICML 2024, PMLR 235:19544–19572. [原始条目](https://proceedings.mlr.press/v235/hu24s.html)（访问：2026-10-15）。

这是便于定位的书目草稿，不是已经完成 GB/T 7714 排版的最终条目；使用前从所选版本导出完整作者、文献类型、正式年份、卷页与 DOI。
