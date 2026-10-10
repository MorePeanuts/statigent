# 本地基准数据

对应研究方案见 [overview.md](../docs/overview.md)，基准用途、示例和评分解释见 [benchmark.md](../docs/benchmark.md)。本目录准备数据与必要评分资源，不代表已经完成智能体接入或跑过实验。

**主基准已全部下载并通过校验。** 2026-10-10 的全量校验通过了 2,397 条文件清单检查，五套基准均达到本次选定范围，未发现问题；[下载状态](metadata/download-status.json) 中 `all_required_downloads_complete` 为 `true`。下载作业已结束，临时下载文件与 Xet 缓存已清理。作业记录见 [background-status.json](metadata/background-status.json)，日志保留在忽略 Git 的 `.logs/` 目录。

## 下载范围

| 基准 | 本次范围 | 未下载内容 |
| --- | --- | --- |
| DAComp-DA | 英文版 100 项任务、SQLite、英文评分细则/参考报告及所需图表 | DAComp-DE、中文重复版本、已有 agent 轨迹和模型输出 |
| DSBench-Analysis | 官方索引的 38 个案例、466 道题及案例文件 | 包中索引外的 2 个案例、macOS 元数据 |
| InfiAgent-DABench | 257 道题、对应 52 份 CSV、答案和评分脚本 | 16 份未被题目引用的 CSV、已有方法实现和轨迹 |
| DSBench-Modeling | 74 项索引中的 52 项表格任务，逐项提取任务说明、训练/测试 CSV、评测标签 | 22 项文本/时序/特殊结构任务、索引外任务、旧 Kaggle 提交模板、全量原始比赛数据 |
| TabArena-Lite v0.1 | 51 个 OpenML 数据集（50 份 ARFF、APSFailure 使用官方 Parquet）、任务/数据元数据、每项 `repeat=0, fold=0` 的索引 | 其余外层重复划分、训练好的模型、模型预测缓存、巨量排行榜实验产物 |

这里的“52 项”是下载候选范围，不是已经通过低成本预实验的正式实验集。完整纳入/排除理由见 [DSBench 建模清单](metadata/ds-modeling-selection.json)。不按实验分数选择任务。

DAComp 的 SQLite 总计约 6.13 GB，最大的 `dacomp-061` 约 3.52 GB；它属于主基准的结构化数据，予以保留。其参考报告中的图表属于评分必需材料。DSBench 分块选取的成员压缩体积约 1.70 GB，无需下载完整 3.13 GB 压缩包。磁盘占用会大于网络压缩体积。

## 文件与标签隔离

```text
benchmarks/
  dacomp-da/public/              # 任务说明与 SQLite
  dacomp-da/evaluator/upstream/  # 参考报告、rubric、评分代码
  dsbench/analysis/public/       # 案例文件、去掉答案的 tasks.jsonl
  dsbench/analysis/private/      # 官方含答案索引和参考解答
  dsbench/modeling/public/       # 每个任务的 task.txt、train.csv、test.csv
  dsbench/modeling/private/      # 每个任务的 test_answer.csv
  dsbench/upstream/              # 原始评分脚本、参考成绩及说明
  infiagent-dabench/public/      # questions.jsonl、tables/*.csv
  infiagent-dabench/private/     # labels.jsonl
  infiagent-dabench/upstream/    # 许可证和评分说明/代码
  tabarena-lite/raw/<task_id>/   # 官方 ARFF/Parquet、元数据、Lite 划分
  metadata/                     # 来源版本、选择清单、校验值和实际状态
```

**`raw` 中含完整标签，`private` 和 `evaluator` 中含答案/参考材料，都只能由数据准备或评分端访问。** `upstream` 是原样保存的可信评测资源，也可能包含答案，不能把整个项目目录挂载给智能体。正式运行时需要生成独立任务工作目录，只开放允许的输入；目录命名本身不是权限隔离。

TabArena 保留官方原始数据与 Lite 索引。APSFailure（OpenML dataset 46908 v2、task 363616）使用元数据中提供的官方 Parquet 文件，原 ARFF 入口不支持续传且反复截断；其余 50 项使用 ARFF。Parquet 下载按官方响应中的 multipart ETag 校验，并记录 SHA-256；校验器读取全部行组，检查行列数与目标列。任务、数据版本和外层划分均不改变。元数据的 train/test 行数可能是折间平均值，精确行数以实际索引为准。后续按索引生成训练数据、无标签测试数据和私有测试标签。本方法应按官方 `system` 接口管理内部验证、训练与预算，不能直接把全量 ARFF 给智能体。

DSBench 的原始题面/评分脚本可能使用作者本机路径，旧题面中的 Kaggle 行数也可能与本地重划分数据不同。源码按固定版本保存，后续适配时应明确路径、样本 ID 和输出格式；不能把“已下载”称为“已可直接完整评测”。

## 来源与复现

`metadata/revisions.json` 固定 Hugging Face 数据版本；GitHub tree 文件固定评分代码 commit；逐文件清单保存源 URL、字节数与 SHA-256。DSBench 压缩包成员另做 CRC32 校验，DAComp 与 Hugging Face 官方 LFS SHA-256 比对。OpenML 保存 task ID、dataset ID、dataset version 及本地文件校验值。ARFF 与官方 MD5 比对；Parquet 的来源及校验值见相应任务目录的 `parquet-source.json`。下载完成后以 `metadata/download-status.json` 为实际状态。

标准下载器只依赖 Python 标准库，可以重跑并跳过校验通过的文件：

```bash
uv run python benchmarks/download.py assets
uv run python benchmarks/download.py analysis
uv run python benchmarks/download.py dacomp
uv run python benchmarks/download.py modeling
uv run python benchmarks/download.py tabarena
```

Parquet 完整性校验使用独立的 uv 环境：

```bash
uv venv --python 3.12 benchmarks/.venv
uv pip install --python benchmarks/.venv/bin/python pyarrow==26.0.0
```

DAComp 较大的 SQLite 可选择官方 `hf_xet==1.7.0` 压缩/分块传输。此次仅安装到忽略 Git 的本地 `.tools` 目录；脚本也支持普通 Python 环境中已安装的同版本包。Xet 临时缓存位于本目录的 `.xet-cache`，不会作为数据交付物。当前下载器使用约 1 MB 的重构范围，避免慢连接下的大块传输长期无法完成；实时传输量见 `metadata/dacomp-transfer-progress.json`，最终是否完成仍以官方校验值核验结果为准。

```bash
uv run python benchmarks/download_xet.py
```

最大的 `dacomp-061` 另有可恢复传输入口：

```bash
uv run python benchmarks/download_xet_resumable.py
```

它将官方压缩块拆成较小的字节范围，保存到 `.xet-cache/resumable-blocks`，重跑时复用校验通过的数据块；通过只监听本机的临时中继交给官方 `hf_xet` 解码。最终 SQLite 必须与官方 SHA-256 一致，才会替换正式文件。该入口只处理这一项，不改变数据内容和基准任务。

可再次独立核验：`uv run --python benchmarks/.venv/bin/python python benchmarks/verify.py`。本次下载协调器已完成并退出；`metadata/active-jobs.json` 与 PID 文件仅记录本机此次作业，不代表仍有下载进程运行。

DSBench 使用官方发布的预处理数据，TabArena-Lite 使用 OpenML 数据与固定划分；当前下载流程无需 Kaggle 账号或接受竞赛规则。两套建模基准均在本地评分。

数据、上游代码、工具缓存及本机运行产物（进度、PID、错误记录、下载校验报告）已在本目录 `.gitignore` 中忽略；Git 保留文档、下载器、来源版本、任务选择清单和文件校验值。状态报告链接指向本地运行后生成的文件，新克隆的仓库中尚不存在。官方许可/说明随对应资源保存，不将第三方数据重新发布。
