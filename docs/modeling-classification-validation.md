# 表格分类能力验收

验收日期：2026-10-13。

本记录对应 `add-tabular-modeling-classification`。验收对象是第二章统一建模系统的工程闭环，不是论文性能实验或 Benchmark 成绩。合成任务没有按外层测试成绩选择。

## 软件与隔离执行

已完成以下专项检查：

- 二/多分类标签身份、类别顺序、分层划分、支持矩阵和 v1 数据读取。
- runner 编码/解码、classes_ 反序、非法类别/形状、概率行和/范围、缺失接口；Python 检查均经 uv。
- RMSE、accuracy、显式正类 ROC AUC、log-loss 的公式样例与锁定 sklearn 对照；原始预测不被评分改写。
- 分类主循环、最大化/最小化/平局、协议篡改、证据来源、EDA 字段冲突、失败修复与共享预算。
- 真实 Docker：二分类 ROC AUC、多分类 log-loss 各完成初始训练→双角色 EDA→证据关联训练→最终交付→predict/refit 复现→独立评分；二/多分类 accuracy 另有真实训练预测测试。
- 跨层失败：非法概率没有分数；评分进程超时和父取消终止派发，保留失败产物并清理容器。
- 既有回归 Docker 专项 5 项通过，包括超过 16 MiB 的模型、阶段超时、取消、EDA 预算和独立复现。

最终开发镜像为 `sha256:fc2347116d2ac2459584d81ab50f73ae3aa2917281c8b5618fcc4a3049618d0d`。最终分类专项的完整父运行分别为 binary `50b03277-a2b0-495c-8dab-54b0130fc468` 和 multiclass `55dc66e3-4788-4cc6-8ee0-7ccac5bae2d6`。

所有上述模型决策均为可控响应；没有调用付费模型。运行产物保留于忽略目录 `runs/integration-classification/`、`runs/integration-classification-failure/` 和 `runs/integration-modeling-loop/`。

## 旧版只读兼容

实际使用原 v1 运行 `713a98e3-a341-4eb5-9fa1-24f2001d14b3`，保留原镜像 `sha256:67fc94fdc41f49a67075631f1e249db9506630497db06a2c9e6a42235b44ed76`。inspect、原三字段 stage 的 predict/refit 与独立 RMSE 评分均通过，逐文件核对原运行及数据共 128 个文件，哈希未改变。

独立验收报告：`runs/classification-legacy-check/e5149125-58f3-4989-9e63-a48e91c8814e/verification.json`。首次哈希核对脚本受目录遍历顺序影响报告失败，改为按路径排序后重新执行通过；没有改写源记录。

## 真实模型冒烟入口

`configs/modeling/binary-selection.json` 和 `multiclass-selection.json` 冻结合成源文件哈希、生成规则、60 行训练/6 行预测及精确 48/12 内部分层划分。每个任务只使用一个显式指标：binary 为 ROC AUC（正类 `01`），multiclass 为 log-loss（类别 `NA`、`blue`、`红色`）。这不是覆盖所有分类数据分布的实验。

如准备目录尚不存在，先执行：

```sh
bun run modeling prepare --config configs/modeling/binary-prepare.json --out runs/modeling-binary-data
bun run modeling prepare --config configs/modeling/multiclass-prepare.json --out runs/modeling-multiclass-data
```

以下预检已实际执行；不启动模型或 Docker：

```sh
bun run test:smoke:classification --kind binary --preflight
bun run test:smoke:classification --kind multiclass --preflight
```

真实调用使用配置中的模型，需显式单独运行一项：

```sh
bun run test:smoke:classification --kind binary
# 或另一次单独选择 multiclass；命令不自动加跑另一项
bun run test:smoke:classification --kind multiclass
```

每次上限为 900 秒、40 次总模型尝试、600,000 token、3 次搜索拟合和 1 次最终拟合；最终阶段预留 180 秒。EDA 最多 1 次，子用量计入父预算。若两项分别运行，配置合计上限为 1,800 秒、80 次尝试和 1,200,000 token 停止阈值。独立预测复现耗时另列。每次使用新目录，失败报告不被后续尝试覆盖；协作验收要求真实双角色分析和有证据关联的后续训练，不要求成绩提升。

**真实分类模型冒烟：未执行。** 入口与可控响应测试通过不能替代真实模型验收。正式实验、Benchmark 适配和消融仍属于后续变更。

## 全量交付检查

以下命令已实际运行并通过：

| 检查 | 实际结果 |
| --- | --- |
| bun run check | Biome、Ruff、tsc 通过；TypeScript 单元测试 209 项，Python 快速测试 47 项通过 |
| bun run test:integration | TypeScript 集成测试 33 项，Python 真实内核集成测试 6 项通过 |
| 最终代码的分类专项复核 | 5 项 Docker 测试、79 项断言全部通过 |
| 旧回归原镜像验收 | inspect、predict、refit、离线评分通过；128 个源文件哈希不变 |
| 两项 classification --preflight | 冻结文件、划分、类别、主指标与预算预检通过 |
| openspec validate add-tabular-modeling-classification --strict | 通过 |

标签保真和元信息版本边界的自审修复，另由完整快速检查、相关回归用例及最终分类 Docker 专项再次验证。还覆盖了以旧 dataset schema 1 启动新 schema 2 父运行，原数据清单字节未变。

本机沙箱内 uv 曾因 macOS 系统配置访问限制崩溃；检查最终在允许访问本机 uv/Docker 的执行环境中完成。没有用模拟结果替代未执行检查，也没有安装新依赖或调用付费 API。上游数据测试与真实模型冒烟不属于默认检查，本轮未执行。

实现与验收按阶段本地提交，对应 OpenSpec 变更已同步主规格并归档至 [2026-10-13-add-tabular-modeling-classification](../openspec/changes/archive/2026-10-13-add-tabular-modeling-classification/)。实验适配继续后置。
