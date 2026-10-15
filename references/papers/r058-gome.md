# Reasoning as Gradient: Scaling MLE Agents Beyond Tree Search

[返回文献总表](../index.md) · [筛选记录](../screening.md)

## 基本信息

| 字段 | 记录 |
| --- | --- |
| 稳定编号 | R058 |
| 作者 | Yifei Zhang; Xu Yang; Xiao Yang; et al. |
| 最早核验年份 | 2026（已核验来源中的最早年份，不保证等于所有早期稿） |
| 本轮采用载体 / 版本 | arXiv:2603.01692v3（2026-04-12）；Gome |
| 方向 | 建模智能体 |
| 优先级 / 纳入 | P0；纳入参考库 |
| 来源 | 本轮新增 |
| 阅读状态 | L2 定向阅读；未做本地复现 |
| 核验日期 | 2026-10-15 |
| 原文 | [论文主页 / 采用版本](https://arxiv.org/abs/2603.01692v3) |

**书目校正：** 系统称 Gome，论文题名为 Reasoning as Gradient；采用 v3。

## 研究问题与方法

把结构化诊断视作定向更新信号，把成功记忆和多轨迹共享用于持续代码优化；“梯度”是优化类比。 [来源](https://arxiv.org/abs/2603.01692v3)

## 证据与本轮阅读范围

已核查 §3.2、§4.3 和局限：有层次验证及诊断/记忆/多轨迹消融，效果依赖推理模型能力。 [补充来源：正文 §3.2、§4.3 与 Limitations（v3）](https://arxiv.org/html/2603.01692v3)

L2 表示核查了上述指定章节，不表示逐表复核、完整精读或代码复现。作者报告的结果只用于理解其研究范围，不作为 Statigent 实验结果。

## 与 Statigent 的关系（本次分析）

与模型反馈驱动诊断、经验更新高度接近，是第二章贡献边界的首要近期文献。

## 局限与引用边界（本次分析）

不能把语言诊断称为精确数学梯度；封闭世界 MLE-bench 结果不等于本项目表格子集表现。

## 下一步精读

重点比较反馈包含哪些证据、诊断如何触发更新以及弱模型下是否失效。

## 写作引用入口

Yifei Zhang, Xu Yang, Xiao Yang, et al. Reasoning as Gradient: Scaling MLE Agents Beyond Tree Search. arXiv:2603.01692v3（2026-04-12）；Gome. [原始条目](https://arxiv.org/abs/2603.01692v3)（访问：2026-10-15）。

这是便于定位的书目草稿，不是已经完成 GB/T 7714 排版的最终条目；使用前从所选版本导出完整作者、文献类型、正式年份、卷页与 DOI。
