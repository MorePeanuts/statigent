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

当前验收：固定安装、源码哈希、接口/标签/指标探针通过；Statigent 桥接和 r0f0 真实任务调用尚未完成。完整模型和真实运行输出保留在忽略 Git 的运行目录。
