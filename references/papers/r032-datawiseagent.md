# DatawiseAgent: A Notebook-Centric LLM Agent Framework for Adaptive and Robust Data Science Automation

[返回文献总表](../index.md) · [筛选记录](../screening.md)

## 基本信息

| 字段 | 记录 |
| --- | --- |
| 稳定编号 | R032 |
| 作者 | Ziming You; Yumiao Zhang; Dexuan Xu; et al. |
| 最早核验年份 | 2025（已核验来源中的最早年份，不保证等于所有早期稿） |
| 本轮采用载体 / 版本 | EMNLP 2025:1099–1123 |
| 方向 | 数据科学综合 |
| 优先级 / 纳入 | P0；纳入参考库 |
| 来源 | 用户初始列表 #32 |
| 阅读状态 | L2 定向阅读；未做本地复现 |
| 核验日期 | 2026-10-15 |
| 原文 | [论文主页 / 采用版本](https://aclanthology.org/2025.emnlp-main.58/) |

**书目校正：** 采用 EMNLP 2025 正式题名，增加 Adaptive and Robust；Huamin（正式页/PDF）与 Huaming（arXiv）拼写有差异，完整书目按正式版。

## 研究问题与方法

以 Markdown/代码单元统一用户、代理和环境交互；有限状态转换器组织 DFS 式规划、增量执行、自调试和后过滤。 [来源](https://aclanthology.org/2025.emnlp-main.58/)

## 证据与本轮阅读范围

已核查 §3.1–3.3 的表示和阶段设计；正式论文在多种数据科学任务与模型上比较效果。 [补充来源：方法正文 §3.1–3.3（arXiv v2）](https://arxiv.org/html/2503.07044v2)

L2 表示核查了上述指定章节，不表示逐表复核、完整精读或代码复现。作者报告的结果只用于理解其研究范围，不作为 Statigent 实验结果。

## 与 Statigent 的关系（本次分析）

第一章最接近的研究之一：Notebook 与增量执行已有明确先例，需具体检验角色分离和上下文交接的增量价值。

## 局限与引用边界（本次分析）

四阶段流程并不自动等同于四个独立 LLM 角色；整体提升不能拆解成持久内核的单独因果收益。

## 下一步精读

下一步精读实验消融和官方执行代码，制作信息可见性、状态保留与费用统计对照。

## 写作引用入口

Ziming You, Yumiao Zhang, Dexuan Xu, et al. DatawiseAgent: A Notebook-Centric LLM Agent Framework for Adaptive and Robust Data Science Automation. EMNLP 2025:1099–1123. [原始条目](https://aclanthology.org/2025.emnlp-main.58/)（访问：2026-10-15）。

这是便于定位的书目草稿，不是已经完成 GB/T 7714 排版的最终条目；使用前从所选版本导出完整作者、文献类型、正式年份、卷页与 DOI。
