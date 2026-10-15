# MLE-STAR: Machine Learning Engineering Agent via Search and Targeted Refinement

[返回文献总表](../index.md) · [筛选记录](../screening.md)

## 基本信息

| 字段 | 记录 |
| --- | --- |
| 稳定编号 | R042 |
| 作者 | Jaehyun Nam; Jinsung Yoon; Jiefeng Chen; et al. |
| 最早核验年份 | 2025（已核验来源中的最早年份，不保证等于所有早期稿） |
| 本轮采用载体 / 版本 | arXiv:2506.15692v3 |
| 方向 | 建模智能体 |
| 优先级 / 纳入 | P0；纳入参考库 |
| 来源 | 用户初始列表 #42 |
| 阅读状态 | L2 定向阅读；未做本地复现 |
| 核验日期 | 2026-10-15 |
| 原文 | [论文主页 / 采用版本](https://arxiv.org/abs/2506.15692v3) |

## 研究问题与方法

先检索任务适合的模型，再通过组件消融选定代码块；外层切换优化目标，内层集中修订该组件，并探索集成。 [来源](https://arxiv.org/abs/2506.15692v3)

## 证据与本轮阅读范围

已核查 §3.1–3.4；作者在 MLE-bench Lite 报告较高获奖率，但此处不搬用为项目结果。 [补充来源：方法正文 §3.1–3.4（v3）](https://arxiv.org/html/2506.15692v3)

L2 表示核查了上述指定章节，不表示逐表复核、完整精读或代码复现。作者报告的结果只用于理解其研究范围，不作为 Statigent 实验结果。

## 与 Statigent 的关系（本次分析）

与“反馈决定下一步优化方向”直接相关，不能将定向改进本身当作新贡献。

## 局限与引用边界（本次分析）

模型检索与诊断优化是不同因素；联网权限、组件消融训练和集成成本都影响可比性。

## 下一步精读

精读消融与泄漏检测模块，比较组件贡献分析和样本/特征误差诊断的差异。

## 写作引用入口

Jaehyun Nam, Jinsung Yoon, Jiefeng Chen, et al. MLE-STAR: Machine Learning Engineering Agent via Search and Targeted Refinement. arXiv:2506.15692v3. [原始条目](https://arxiv.org/abs/2506.15692v3)（访问：2026-10-15）。

这是便于定位的书目草稿，不是已经完成 GB/T 7714 排版的最终条目；使用前从所选版本导出完整作者、文献类型、正式年份、卷页与 DOI。
