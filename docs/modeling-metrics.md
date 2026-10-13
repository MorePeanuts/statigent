# 建模指标与预测协议 v2

指标 ID、方向、输出类型、参数和边界由 [共享目录](../python/statigent_modeling/metric_definitions.json) 定义，TS 和 Python 校验同一内容及 SHA-256。每个运行冻结 `targets[]`、原始类别顺序、各二元目标正类、等级坐标、特征白名单、预测列和完整协议哈希。类别只可来自允许训练或固定公开协议，不用外层标签补类。`01` 与 `1` 保持不同身份。

## 覆盖表

| 指标 ID | 目标/预测 | 方向 | 冻结边界 |
| --- | --- | --- | --- |
| rmse-v1 | 回归 / numeric | 最小化 | 原尺度，无上界；溢出报错 |
| mae-v1 | 回归 / numeric | 最小化 | 原尺度，无上界 |
| median-absolute-error-v1 | 回归 / numeric | 最小化 | 绝对误差中位数 |
| rmsle-numpy-log-v1 | 回归 / numeric | 最小化 | `log(x+1)`，真实值/预测均大于 −1；不裁剪 |
| rmsle-numpy-log1p-v1 | 回归 / numeric | 最小化 | `log1p(x)`，同上；与前一数值实现分别保留身份 |
| rmsle-sklearn-v1 | 回归 / numeric | 最小化 | 固定 sklearn 1.7.2 的 MSLE 开方，允许 (−1,0)，不能套用旧版本的非负约束 |
| r2-sklearn-v1 | 回归 / numeric | 最大化 | `force_finite=True`；常量完美=1、非完美=0；至少两条，无下界 |
| smape-ds-v1 | 回归 / numeric | 最小化 | `mean(2*abs(p-y)/(abs(p)+abs(y)))`；双零未定义 |
| smape-zero-v1 | 回归 / numeric | 最小化 | 双零计零的独立定义；不用于 DSBench 主结果 |
| accuracy-v1 | 分类/等级 / label | 最大化 | 原标签精确比较 |
| micro-f1-v1 | 分类/等级 / label | 最大化 | micro 聚合，保留原指标身份 |
| roc-auc-v1 | 二分类 / probabilities | 最大化 | 显式正类；并列半分；评价单类未定义 |
| log-loss-sklearn-v1 | 分类 / probabilities | 最小化 | 冻结训练类别；float64 epsilon；自然对数；保持 sklearn 1.7 数值规则 |
| log-loss-sklearn-inferred-binary-v1 | 二分类 / probabilities | 最小化 | DSBench s3e10：导出正类列，由 sklearn 补反类并从评价标签推断类别；单类未定义 |
| normalized-gini-ds-v1 | 二分类 / probabilities | 最大化 | 预测降序、固定评价行序解并列；除以 `gini(y,y)`；非 `2*AUC−1` |
| quadratic-kappa-ds10-v1 | 等级 / label | 最大化 | 显式整数坐标 0–9、N=10；非连续等级不压缩；零分母未定义 |
| top3-hit-ds-v1 | 多分类 / ranked-labels | 最大化 | 一至 min(3,C) 个不重复候选；不奖励位置 |
| mean-target-auc-v1 | 多目标二分类 / multilabel-probabilities | 最大化 | 每目标 AUC 等权；任一未定义使整体失败，保留分项 |

范围值可以没有有限上下界，分数自身必须有限。评分只处理数据文件，绝不加载模型。非法预测与材料损坏/指标未定义分开：后者是 scoring failure，不能伪造零分。所有阶段共用同一指标目录；搜索验证、训练诊断、确认验证/诊断和外层测试保留不同 `partition`、`evaluation_id`，跨分区或版本不得比较。当前 v2 可信评分模块已实现；原生训练控制流接线仍在变更任务中。

## 预测格式

CSV 第一列为冻结 ID，后续列名由协议生成，避开 ID、特征、目标列名冲突。ID 集合须一一对应，评分按标签的固定评价顺序对齐；重复、缺失或额外 ID 均拒绝。

- numeric：一个原尺度有限数值。
- label：一个原始类别标签。
- probabilities：派生标签及完整类别概率；类别顺序来自协议，行和误差最多 `1e-6`。标签为最大概率类别，平局取冻结顺序第一项。
- multilabel-probabilities：按目标顺序保存各自派生标签和两类概率；每个目标内行和为一，跨目标正类概率无需和为一。
- ranked-labels：CSV 单元保存 JSON 字符串数组；外部交付可只含 ID 与候选列表。若附完整概率，列表必须与稳定排序一致。Statigent 模型输出会生成完整概率并取前三；DSBench 官方导出另用空格拼接，含空白的类别不能无歧义导出时须预检拒绝。

## 来源差分与偏离

独立入口（需本地上游及已安装的 [官方环境](../environments/tabarena/README.md)）：

```bash
bun run test:modeling:upstream
```

2026-10-14 已直接执行固定的 52 个 DSBench 脚本，每题普通/并列两组，共 104 项通过；双零 SMAPE 边界 1 项通过（上游 NaN，本地明确未定义）。两环境的 TabArena RMSE/AUC/log-loss 同预测差分通过。有限结果使用绝对/相对 `1e-12` 容差，不用名称相同代替数值核对。单位测试另验证负预测定义域、常量目标、Kappa 距离、前三候选位置、ID 乱序等价与缺失/重复拒绝。

| 已知偏离 | 本地主兼容处理 |
| --- | --- |
| s3e13 题面有位置权重，代码无权重 | 使用前三命中，不能称 MAP@3 |
| s3e19 题面双零记零，代码返回 NaN | 主协议明确 scoring failure，不改成零项 |
| s3e20 的 smape 变量、s3e23 的 rmse 变量误名 | 分别按实际 RMSE、AUC |
| s3e10 优先读取 Strength，否则 Class | 显式导出 Class，固定 fallback 和二元正类列口径 |
| 多个脚本 `sort_values` 未赋回 | 本地按 ID 对齐后再做上游差分，保留评价行序解 Gini 平局 |
| 中间量溢出可能偶然得到有限结果 | 本地明确报错；不把溢出视为合法成绩 |

上述是软件计算证据，不代表真实候选模型已完成训练或正式实验。

## 历史兼容

v1 保留 `tabular-metrics-v1` 的原始 JSON 序列化、类别排序、二元正类、log-loss `1e-15` clipping/归一化及哈希。v2 不改写旧数据或记录；共享 TS/Python 夹具包含冻结 v1 协议并验证同一哈希。旧分数不能只因指标名称近似就与 v2 混排。
