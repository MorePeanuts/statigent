# DSBench 建模逐题协议审计

上游代码 commit：`ba786096137a5108af11c016ad3f09cdb97beefd`。逐题脚本与公开输入 SHA-256 见 [候选目录](../benchmarks/metadata/modeling-task-catalog.json)。

本表由 `statigent_benchmarks.ds_catalog` 按人工映射和本地发布数据生成；只读扫描，不训练、不调用模型。指标 ID 绑定实际算法变体，未完成差分/端到端验收前不代表适配已通过。身份为固定来源行号的任务另保存导出映射；不采用上游未赋回排序导致的错行行为。

| 任务 | 目标 | 指标（方向） | 训练/测试行 | 特征数 | 身份 | 额外排除 | 偏离 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| titanic | Survived | accuracy-v1 (maximize) | 712/179 | 10 | PassengerId | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| santander-customer-transaction-prediction | target | roc-auc-v1 (maximize) | 160000/40000 | 200 | ID_code | — | — |
| porto-seguro-safe-driver-prediction | target | normalized-gini-ds-v1 (maximize) | 476169/119043 | 57 | id | — | — |
| santander-customer-satisfaction | TARGET | roc-auc-v1 (maximize) | 60816/15204 | 369 | ID | — | — |
| santander-value-prediction-challenge | target | rmsle-numpy-log-v1 (minimize) | 3567/892 | 4991 | ID | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s4e1 | Exited | roc-auc-v1 (maximize) | 132027/33007 | 12 | id | — | — |
| playground-series-s4e2 | NObeyesdad | accuracy-v1 (maximize) | 16606/4152 | 16 | id | — | — |
| bike-sharing-demand | count | rmsle-numpy-log-v1 (minimize) | 8708/2178 | 9 | source-row | casual, registered | casual、registered 为训练独有标签，必须排除；datetime 保留为特征，身份采用固定来源行号 |
| playground-series-s4e5 | FloodProbability | r2-sklearn-v1 (maximize) | 894365/223592 | 20 | id | — | — |
| playground-series-s4e4 | Rings | rmsle-sklearn-v1 (minimize) | 72492/18123 | 8 | id | — | — |
| microsoft-malware-prediction | HasDetections | roc-auc-v1 (maximize) | 380410/95103 | 81 | MachineIdentifier | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| spaceship-titanic | Transported | accuracy-v1 (maximize) | 6954/1739 | 12 | PassengerId | — | — |
| dont-overfit-ii | target | roc-auc-v1 (maximize) | 200/50 | 300 | id | — | — |
| playground-series-s4e3 | Pastry, Z_Scratch, K_Scatch, Stains, Dirtiness, Bumps, Other_Faults | mean-target-auc-v1 (maximize) | 15375/3844 | 27 | id | — | 默认 NObeyesdad 及未调用 logloss 函数无效；实际七目标 AUC 等权平均 |
| tabular-playground-series-sep-2021 | claim | roc-auc-v1 (maximize) | 416946/104237 | 118 | id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e24 | smoking | roc-auc-v1 (maximize) | 127404/31852 | 22 | id | — | — |
| tabular-playground-series-aug-2022 | failure | roc-auc-v1 (maximize) | 21256/5314 | 24 | id | — | — |
| playground-series-s3e14 | yield | mae-v1 (minimize) | 12231/3058 | 16 | id | — | — |
| instant-gratification | target | roc-auc-v1 (maximize) | 209715/52429 | 256 | id | — | — |
| tabular-playground-series-aug-2021 | loss | rmse-v1 (minimize) | 200000/50000 | 100 | id | — | — |
| tabular-playground-series-jan-2021 | target | rmse-v1 (minimize) | 240000/60000 | 14 | id | — | — |
| playground-series-s3e23 | defects | roc-auc-v1 (maximize) | 81410/20353 | 21 | id | — | rmse 变量实际调用 roc_auc_score，按 AUC 最大化；原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e25 | Hardness | median-absolute-error-v1 (minimize) | 8325/2082 | 11 | id | — | — |
| playground-series-s3e22 | outcome | micro-f1-v1 (maximize) | 988/247 | 27 | id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e17 | Machine failure | roc-auc-v1 (maximize) | 109143/27286 | 12 | id | — | — |
| tabular-playground-series-mar-2021 | target | roc-auc-v1 (maximize) | 240000/60000 | 30 | id | — | — |
| playground-series-s3e20 | emission | rmse-v1 (minimize) | 63218/15805 | 74 | ID_LAT_LON_YEAR_WEEK | — | smape 变量实际为 RMSE；默认 value 为 Machine failure，实际读取 emission；原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| tabular-playground-series-feb-2021 | target | rmse-v1 (minimize) | 240000/60000 | 24 | id | — | — |
| playground-series-s3e16 | Age | mae-v1 (minimize) | 59240/14811 | 8 | id | — | 默认 yield 无效；显式导出 Age，选择上游优先 Age 分支；原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| tabular-playground-series-nov-2021 | target | roc-auc-v1 (maximize) | 480000/120000 | 100 | id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| cat-in-the-dat | target | roc-auc-v1 (maximize) | 240000/60000 | 23 | id | — | — |
| tabular-playground-series-feb-2022 | target | accuracy-v1 (maximize) | 66900/16725 | 286 | row_id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| tabular-playground-series-apr-2021 | Survived | accuracy-v1 (maximize) | 80000/20000 | 10 | PassengerId | — | — |
| tabular-playground-series-dec-2021 | Cover_Type | accuracy-v1 (maximize) | 3200000/800000 | 54 | Id | — | — |
| playground-series-s3e19 | num_sold | smape-ds-v1 (minimize) | 109560/27390 | 4 | id | — | 题面双零记零，发布 SMAPE 表达式双零产生 NaN；主协议保持未定义并报告评分错误；默认 value 为 Machine failure，实际固定读取 num_sold |
| cat-in-the-dat-ii | target | roc-auc-v1 (maximize) | 480000/120000 | 23 | id | — | — |
| tabular-playground-series-may-2022 | target | roc-auc-v1 (maximize) | 720000/180000 | 31 | id | — | — |
| playground-series-s3e12 | target | roc-auc-v1 (maximize) | 331/83 | 6 | id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e18 | EC1, EC2 | mean-target-auc-v1 (maximize) | 11870/2968 | 31 | id | EC3, EC4, EC5, EC6 | 仅预测 EC1、EC2；EC3–EC6 是训练独有标签，全部排除特征；默认 value 为 Machine failure，实际读取 EC1、EC2 |
| playground-series-s3e11 | cost | rmsle-sklearn-v1 (minimize) | 288268/72068 | 15 | id | — | — |
| playground-series-s3e13 | prognosis | top3-hit-ds-v1 (maximize) | 565/142 | 64 | id | — | 题面的位置权重与代码不符：实际为无位置权重的前三命中；导出按空白拆分，类别含空白须阻塞；原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e5 | quality | quadratic-kappa-ds10-v1 (maximize) | 1644/412 | 11 | Id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e10 | Class | log-loss-sklearn-v1 (minimize) | 94051/23513 | 8 | id | — | 上游优先读取 Strength，否则 Class；本地显式导出 Class，使用 fallback 分支；原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e2 | stroke | roc-auc-v1 (maximize) | 12243/3061 | 10 | id | — | — |
| playground-series-s3e9 | Strength | rmse-v1 (minimize) | 4325/1082 | 8 | id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e8 | price | rmse-v1 (minimize) | 154858/38715 | 9 | id | — | — |
| playground-series-s3e6 | price | rmse-v1 (minimize) | 18184/4546 | 16 | id | — | — |
| playground-series-s3e1 | MedHouseVal | rmse-v1 (minimize) | 29709/7428 | 8 | id | — | 存在未调用 rmsle 函数；实际为 RMSE |
| playground-series-s3e7 | booking_status | roc-auc-v1 (maximize) | 33680/8420 | 17 | id | — | — |
| playground-series-s3e3 | Attrition | roc-auc-v1 (maximize) | 1341/336 | 33 | id | — | 原 sort_values 未赋回；本地先按固定评价成员顺序对齐 ID，再调用上游公式 |
| playground-series-s3e4 | Class | roc-auc-v1 (maximize) | 175303/43826 | 30 | id | — | — |
| playground-series-s4e6 | Target | accuracy-v1 (maximize) | 61214/15304 | 36 | id | — | — |
