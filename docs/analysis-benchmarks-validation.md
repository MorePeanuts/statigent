# 分析基准接入验收记录

日期：2026-10-12。变更：`add-analysis-benchmarks`（契约 v2、LLM 评委评分、DAComp-DA 与 DSBench-Analysis 接入）。这是软件接入与固定开发冒烟的验收，不是正式实验或论文方法复现；开发冒烟的分数不能作为任何结论。

## 自动检查

| 检查 | 实际结果 |
| --- | --- |
| `bun run check` | Biome、Ruff、TypeScript 通过；126 项 TypeScript 快速测试、33 项 Python 快速测试通过 |
| `bun run test:integration` | 20 项 TypeScript Docker 集成测试、6 项 Python 集成测试（真实内核与执行镜像读取 xlsx/xlsb）通过 |
| `bun run test:evaluation:upstream` | 19 项本地上游差分测试通过（InfiAgent、DSBench `compute_answer.py`、DAComp `core/*`，上游文件未修改） |
| `openspec validate add-analysis-benchmarks --strict` | 通过 |

默认检查不调用付费模型、不下载数据。评委、模型视觉片段与无工具调用使用回环假服务和可控评委测试；DAComp 上游差分逐字节比对 prompt 文本、图片顺序与内容、回复解析、GSB 映射、无图规则和加权总分。

**v1 记录兼容**：真实的 InfiAgent 三题批次 `ff53e5a2-2b11-4c11-b260-99a07bec14c8`（契约 v1）可正常 inspect，离线重评得到 score_id `1cbb91f3-2283-4323-8c27-acbeb3143de0`，ABQ=1、PSAQ=1，与原评分一致；除新增的评分目录外，批次内所有文件的 SHA-256 不变。合成命令批次 `4af20a46-…` 同样可读。

**真实数据预检**：DSBench-Analysis 466 题（38 个案例，140 题空输入）全部通过预检，`00000006/get_results.ipynb` 被排除；DAComp-DA 100 题全部通过预检（含对全部数据库与评分材料的完整哈希，约 6.5 秒）。

## 环境

源码：真实调用均在干净工作区运行，commit `5924ccec3c82bb9e4433066ce8ec7de1a3def6cd`。macOS 15.7.4（Darwin 24.6.0）、Apple M1 Pro（8 核、16 GiB）、Bun 1.4.2、uv 0.8.22、Docker 29.4.0。执行镜像加入 openpyxl 3.1.5 与 pyxlsb 1.0.10 后重建，镜像 ID 为 `sha256:be16e287ff5e64098618358be8d8b528d3b0fe9171a39f5ef22b859019d45a1d`（linux/arm64），与此前记录中的 `c6349da3…` 不同。

模型：智能体 `deepseek-flash`（thinking enabled、reasoning_effort high、max_tokens 65536）；评委 `deepseek-flash-judge`（请求名 `deepseek-flash`，thinking disabled、temperature 0、max_tokens 16384、声明视觉能力）。服务返回模型名 `deepseek-flash`，指纹 `aeb56401ca74e127821c4f9126dcb669`。智能体与评委为同一模型，报告中均自动标记 `self_preference_risk`。货币费用未计算。

## 视觉评委连通冒烟（8.2）

`bun run test:smoke:judge`，smoke_id `d09c4188-5dd2-4a9b-9bc4-cf03bc00c3a5`。以 dacomp-002 的第 2 份参考报告（含图）为候选，与第 0 份参考报告做一次 GSB 视觉比较，共发送 7 张图片：1 次请求、输入 9,156 / 输出 415 token、约 4.5 秒，回复可按上游规则解析。回复内容具体评价了候选图表（例如 x 轴日期标签重叠），说明图像输入被实际使用。thinking 关闭的评委 profile 无需调整。

## DSBench-Analysis 冒烟（8.3）

配置 `configs/evaluations/dsbench-analysis-smoke.json`（开发清单在真实调用前于 `0a0faf0` 提交）。批次 `d094e1bc-96ca-4d58-9208-389b741e91c3`，score_id `c188f82f-8c4a-48a5-819c-b9dca791ab0b`，只运行一次。

| 任务 | 执行 / 评分 | 结果 | 智能体请求 / token | 评委请求 / token |
| --- | --- | --- | --- | --- |
| 00000001-question6 | completed / scored | 正确（选 D） | 2 / 5,741 | 1 |
| 00000001-question7 | completed / scored | 正确（选 D） | 9 / 81,471 | 1 |

汇总：accuracy=1、case_accuracy=1（单个案例）。智能体共 11 次请求、87,212 token（测得，0 未知）；评委共 2 次请求、448 token，单列报告。输入均以 clone 方式发布，批次结束后无遗留容器。

## DAComp-DA 冒烟（8.3）

配置 `configs/evaluations/dacomp-da-smoke.json`（开发清单在真实调用前于 `001e1a9` 提交），主口径，未启用兼容模式。批次 `c3452489-2a09-4762-ba6b-c7826730ec8a`，score_id `afe9bdb3-5bce-4a88-830d-e675cbae0a98`，只运行一次，不追加尝试、不换题。

| 任务 | 执行 / 评分 | 交付 | total | 智能体请求 / token | 评委请求 / token |
| --- | --- | --- | --- | --- | --- |
| dacomp-002 | completed / scored | report.md + 3 张 PNG | 83.82 | 9 / 62,906 | 11 / 65,415 |
| dacomp-017 | budget_exhausted（executions）/ scored | 无 | 0 | 9 / 66,868 | 0 |

dacomp-002 各项：rubric_ratio 0.864，completeness 100，accuracy 33.3，conclusiveness 100，readability 1，professionalism 1，visualization 0.6。dacomp-017 用完 EDA 默认的 8 次代码执行上限，没有提交报告，按固定分母规则各项计 0、不调用评委。批次汇总 total 41.91（两题平均），评分覆盖率 1；智能体共 18 次请求、129,774 token，评委 11 次、65,415 token，0 未知用量，无遗留容器。

**单题评委开销实测**（dacomp-002，主口径，无解析重试）：

| 请求类型 | 次数 | 输入 token | 输出 token | 图片 |
| --- | --- | --- | --- | --- |
| rubric | 1 | 6,613 | 2,221 | 0 |
| GSB 文本比较 | 5 | 19,124 | 1,909 | 0 |
| GSB 视觉比较 | 5 | 33,999 | 1,549 | 25 |
| 合计 | 11 | 59,736 | 5,679 | 25 |

按[评测说明](evaluation.md#dacomp-da-评分)的估算方法，含图报告每题评委约 6.5 万 token、11 次请求；无图报告约 3 万 token、6 次请求；兼容口径约再加一次 rubric（约 9k token）。这只是单题数据，正式实验前应以开发清单的实测分布重新估算。

## 已知局限与后续

- **EDA 代码执行上限不可配置**：评测配置只向 Statigent 传递模型尝试次数、token 阈值与时限，EDA 的代码执行次数仍是默认 8 次。dacomp-017 因此以 `budget_exhausted` 结束。多步报告任务需要在后续变更中把执行次数等预算暴露给适配器配置；本次不改，也不重跑。
- 智能体与评委使用同一模型，存在自评偏差风险；正式实验的评委选择与是否重复评委评分留待后续决定。
- 智能体看不到自己画的图，报告对图表的描述只能依据计算结果。
- DSBench 案例中的 5 张图片以文件形式发布，智能体无法理解图片内容。
- 2026-10-12 之前的 EDA 与 InfiAgent 冒烟使用 `max_tokens` 4096，与本记录的 65536 配置不同，不放在一起比较。

完整运行产物、评委日志和交付文件位于 Git 忽略的 `runs/`，本记录只提交身份、汇总和实测用量，不提交数据、评分材料、答案、密钥或完整轨迹。
