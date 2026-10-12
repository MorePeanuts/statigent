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
