# TabArena 官方兼容环境

这是显式安装、独立锁定的验证环境。默认 `bun run check`、主 `.venv` 和训练镜像均不导入它；不安装可选模型 extras，也不自动下载数据、权重或运行排行榜。

固定代码为 [df2f7533fc0cb3a781d8d4d4b12129644bfcf748](https://github.com/autogluon/tabarena/tree/df2f7533fc0cb3a781d8d4d4b12129644bfcf748)，数据 revision 为 `9044df07027054209362651af7c9502036aa92f0`，二者不是同一身份。51 项 OpenML dataset version 与 r0f0 文件哈希见 [候选目录](../../benchmarks/metadata/modeling-task-catalog.json)。接口与评分源码哈希见 [来源记录](../../src/evaluation/benchmarks/modeling/tabarena-provenance.json)。

在仓库根目录执行（Python 3.12，uv 0.8.22）：

```bash
uv sync --frozen --project environments/tabarena
OPENML_CACHE_DIR=/private/tmp/statigent-openml PYTHONPATH=python uv run --offline --no-sync --frozen --project environments/tabarena python -m statigent_benchmarks.tabarena_compat
```

依赖使用完整 uv.lock，当前官方最低要求含 AutoGluon nightly，因此允许预发布解析并冻结解析结果；不要在复验时自动 upgrade。官方环境的 numpy/pandas/sklearn 与主评分环境不同，后续差分必须分别记录环境及数值规则，不能只按函数名判断等价。

接口探针实际导入已安装的官方 `ExternalSystemModel`，通过原始标签、资源参数和预测接口，再调用官方 `experiment_runner.evaluate` 检查三种指标；0 次 LLM、0 次模型训练。探针不代表 Statigent wrapper 或真实任务已验收。

`_fit_system` 接收完整外层训练 X/y、target_name、problem_type、eval_metric、validation_metadata、num_cpus、num_gpus、memory_limit（GB）、time_limit（秒）、random_state。它不接收测试集或外层验证集。system 自行处理原始标签；官方 runner 只用训练 y 构造 `LabelCleaner`。返回概率必须先按该 cleaner 的 `ordered_class_labels` 排列：二分类转换会直接替换列名，不能期待评分端按原标签修正错序。官方 RMSE/log-loss 的 error 等于原生非负损失；AUC 的 error 为 `1 − AUC`。

`statigent_benchmarks.tabarena_system.StatigentSystem` 继承这个固定官方类，构造时校验源码、接口及依赖锁。`mode` 必须显式指定：`deterministic` 使用固定决策和真实 sklearn 流水线，零 LLM；`live` 使用任务配置的模型与方法，需要显式 `models` 配置路径和对应环境凭据。没有外部 HPO；模型选择、内部划分和终局确认均使用原生建模循环。

先构建具有 stage 4 能力的 `statigent-runtime:modeling-benchmarks` 镜像，再从根目录运行小型、零 LLM 示例：

```bash
PYTHONPATH=python uv run --project environments/tabarena --frozen --offline python -m statigent_benchmarks.tabarena_system_smoke --config configs/modeling/tabarena-system-deterministic.json --runs runs/tabarena-system-example --kind binary
bun run test:modeling:system
```

示例只接受 deterministic 配置，一次拟合、两次独立预测，失败不自动重跑。每次拟合内部仍包含固定搜索试验及最终拟合；“一次 system fit”不等于一次 estimator.fit。测试另外覆盖回归、多分类、官方评分对照、资源不足拒绝、取消和清理。默认 `bun run check` 不执行此入口。

system fit 的计时包含训练输入准备、内部搜索/EDA、确认、最终拟合和冻结。官方有限 time_limit 与任务总时限取较小值，并扣除准备时间；低于既定收尾预留时在模型调用前拒绝。CPU、内存（十进制 GB）取官方约束与本地配置的较小值；不支持 GPU、时间/组划分及自定义非目标分层时明确拒绝。训练只生成 search 数据，不能携带测试分区；所有原始特征和标签类型映射保留在准备清单。

每次 predict/predict_proba 使用独立显式 `prediction_timeout_seconds`，包含输入准备、Docker 加载冻结模型、预测和校验；保持原始 DataFrame 索引，分类返回训练确定的官方类别顺序。后续预测不新增拟合或 LLM，不访问外层标签。standalone 的 fit→predict 由同一父时限覆盖；system 的 fit 和各次 predict 分别计时，比较成本时必须保留这一区别。

`cancel()` 将取消传给当前 Bun 父进程；`cleanup()` 等待本实例活动进程退出、禁止继续预测，保留模型、输入和记录供复核，不删除其他运行或执行全局 Docker 清理。超时先发取消信号，30 秒退出宽限后仍未退出才终止本进程组，并标明未确认清理。桥接请求/响应限 1 MiB、stderr 限 64 KiB，环境按运行时白名单及所选 profile 的凭据名注入；凭据不写入请求或训练容器。

当前验收：固定安装和探针通过；真实官方 system 合成三类任务及资源拒绝共 7 项通过（117.38 秒、零 LLM）。r0f0 小型真实任务的官方调用尚未执行。完整模型和真实运行输出保留在忽略 Git 的运行目录，分层状态见 [验收记录](../../docs/modeling-benchmarks-validation.md)。
