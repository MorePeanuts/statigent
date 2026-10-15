# MLToolBench: Learning Tool-Augmented Agents for Machine Learning Development

[返回文献总表](../index.md) · [筛选记录](../screening.md)

## 基本信息

| 字段 | 记录 |
| --- | --- |
| 稳定编号 | R059 |
| 作者 | Xin Yu; Lizhu Zhang; Jiamu Bai; et al. |
| 最早核验年份 | 2026（已核验来源中的最早年份，不保证等于所有早期稿） |
| 本轮采用载体 / 版本 | arXiv:2609.36679v2（2026-10-06） |
| 方向 | 建模智能体 |
| 优先级 / 纳入 | P0；纳入参考库 |
| 来源 | 本轮新增 |
| 阅读状态 | L2 定向阅读；未做本地复现 |
| 核验日期 | 2026-10-15 |
| 原文 | [论文主页 / 采用版本](https://arxiv.org/abs/2609.36679v2) |

**书目校正：** 采用 v2（2026-10-06）；摘要内部另称工具套件 ToolMLBench，书目保持论文正式题名 MLToolBench。

## 研究问题与方法

提供数据检查、代码验证和实验诊断工具，以 SFT/RL 学习调用；SPICE 用特权上下文对动作似然的影响构造回合奖励。 [来源](https://arxiv.org/abs/2609.36679v2)

## 证据与本轮阅读范围

已核查摘要及附录 B.1/B.2：训练与未适配接口条件有对比，调用覆盖率和成功率分别报告。 [补充来源：正文及附录 B.1/B.2（v2）](https://arxiv.org/html/2609.36679v2)

L2 表示核查了上述指定章节，不表示逐表复核、完整精读或代码复现。作者报告的结果只用于理解其研究范围，不作为 Statigent 实验结果。

## 与 Statigent 的关系（本次分析）

直接提醒“提供 EDA 工具”不等于“能有效使用”；支持研究工具接入之外的决策机制。

## 局限与引用边界（本次分析）

合成任务训练与当前固定模型编排不同；调用次数、工具多样性和奖励分数均不证明因果贡献。

## 下一步精读

精读特权信息只在何处使用、ID/OOD 划分与训练种子；不把训练信息带入本地正式搜索。

## 写作引用入口

Xin Yu, Lizhu Zhang, Jiamu Bai, et al. MLToolBench: Learning Tool-Augmented Agents for Machine Learning Development. arXiv:2609.36679v2（2026-10-06）. [原始条目](https://arxiv.org/abs/2609.36679v2)（访问：2026-10-15）。

这是便于定位的书目草稿，不是已经完成 GB/T 7714 排版的最终条目；使用前从所选版本导出完整作者、文献类型、正式年份、卷页与 DOI。
