# 建模智能体

当前变更分阶段实现回归/RMSE 闭环。分类和其他指标在预检时拒绝。

## 准备数据

输入为一个带目标的训练 CSV 和一个不含目标的预测 CSV，必须有不重叠的唯一稳定 ID、相同特征及有限数值目标。ID 不作为训练特征。准备过程不读取测试标签、不调用模型、不修改源数据。

```sh
bun run modeling prepare --config configs/modeling/synthetic-prepare.json --out runs/modeling-synthetic-data
```

输出目录必须尚不存在，父目录必须存在。生成只读 train.csv/test.csv 和 dataset.json，后者保存文件哈希、目标、种子、指标方向及精确内部划分。默认按 seed 与行 ID 哈希排序生成 80/20 留出；可显式给出完整且不相交的 split.train/split.validation ID 清单。搜索不能重新划分。

源配置使用 input_root/train/test/target/id_column/kind/metric/seed；只接受 regression/rmse。原始数据和准备产物不提交 Git。每次加载校验哈希、列结构和划分成员，输入变化须重新准备并保留新版本。

## 实验执行

生成代码导出 `build_pipeline(seed)`，返回支持 `fit(X, y)`/`predict(X)` 的 scikit-learn 兼容回归流水线。预处理放入流水线；目标变换须在 predict 时逆变换。X 不含 ID 和目标列。运行镜像锁定 scikit-learn 1.7.2、scipy 1.16.2、joblib 1.5.2，不能运行时安装库。

每个实验分别启动新的拟合和预测容器，前者只发布内部训练数据，后者只发布模型、代码和无标签验证特征。模型仅在容器反序列化；宿主校验预测的 ID、列和有限值，再独立计算原尺度 RMSE。代码自报成绩不参与比较。每阶段保存原生事件、实际代码、Notebook、输入/镜像身份和产物快照。失败尝试保留，不复用其状态。

默认拟合上限 120 秒、预测 30 秒；建模配置显式使用 2 GiB 内存、256 MiB 工作区、单产物 16 MiB、累计产物 64 MiB。超时、取消、不完整收集或超限均不产生成功实验。

## 父运行与预算

父运行保存 modeling.json、追加 events.jsonl 和有界 payloads，关联每次训练阶段及 EDA 子运行。使用 `bun run modeling inspect --run RUN_DIRECTORY` 检查父运行和未确认子调用。原 EDA 的 manifest.json 与 Notebook 读取方式不变。

总模型尝试及 token 包含建模智能体和 EDA 全部角色/重试；EDA 子额度从父剩余量分配，结果按调用身份只结算一次。默认最多 3 次搜索拟合、1 次最终拟合，最终拟合/预测预留 180 秒；预留属于总任务 900 秒的一部分。未知模型用量导致全任务停止。总墙钟和阶段耗时分列，不能再次相加。

## 建模与定向 EDA

```sh
bun run modeling run --task configs/modeling/synthetic.json
```

此命令调用真实模型，使用配置中的 model_profile/eda_profile；`--model ID` 可同时覆盖两者。建模智能体只有 run_experiment/analyze/finish_modeling 三个动作。分析必须描述候选、疑问、证据需求和结果如何影响选择；随后训练关联已接受的分析身份、来源实验与有效证据。普通运行允许直接训练或无 EDA 完成，协作验收则要求真实走过分析后训练。

每次 EDA 为独立双角色子运行，同次 EDA 内部共享 Notebook；多次调用通过显式文件和结构化结果交接。失败分析只作为诊断，不能引用为成功证据。后续训练变差时保留原最佳实验；平局保留先完成者。

完成动作冻结最佳流水线，在全部允许训练数据上重新拟合，再对外层无标签特征预测。拟合/验证预测/最终预测均独立隔离。最终拟合失败不会降级为验证模型却报告成功。交付保存于父运行 delivery/，不在宿主反序列化模型。

```sh
bun run modeling reproduce --run RUN_DIRECTORY
bun run modeling reproduce --run RUN_DIRECTORY --mode refit
bun run modeling score --run RUN_DIRECTORY --labels-root PRIVATE_DIRECTORY --labels labels.csv
```

reproduce 默认在新容器恢复已保存模型，以 `atol=1e-8, rtol=1e-6` 比对预测；refit 则重新执行冻结流水线的全训练数据拟合及预测。两者均无 LLM 调用，独立保存到 runs/modeling-reproductions，不覆盖原运行。它们不重演分析与实验决策。输入或镜像身份不匹配时拒绝同条件复现。

score 只接受已完成且交付冻结的运行，私有标签 CSV 必须恰为 ID 列和目标列，样本与预测一一对应。结果保存在独立 runs/modeling-scores，搜索不会接收它。内层 RMSE 与外层 RMSE 分列，不用内层自适应分数证明泛化收益。

## 固定开发任务

`configs/modeling/dsbench-s3e9-selection.json` 冻结公开数据来源、哈希与精确内部划分。选择依据为公开 RMSE 回归、已下载且文件小；未按测试分数选择。该任务只用于开发，不代表完整 DSBench 适配或正式实验。

```sh
bun run modeling prepare --config configs/modeling/dsbench-s3e9-prepare.json --out runs/modeling-s3e9-data
```

目标 Strength，种子 42；使用本地 DSBench 重划分数据的样本身份，忽略旧 Kaggle 题面示例行数。无需下载原始补充数据。默认快速测试使用合成数据和可控模型，Docker 整链测试另行执行。

```sh
bun run test:smoke:modeling
```

这是独立付费入口，固定使用 `dsbench-s3e9.json` 和 deepseek-flash；调用前核对已提交的来源清单、输入哈希及精确划分。最多运行一次建模任务，全部角色共享 40 次尝试、600,000 token 阈值和 900 秒，EDA 子上限 20 次/400,000 token/300 秒。成功后无模型地复现预测并独立评分；任一验收失败保存 smoke-result.json、以非零退出且不自动加跑。预测改善不是通过条件。
