# 建模基准接入验收记录

本记录随 `add-modeling-benchmarks` 实施更新。软件模块、真实数据准备、真实智能体验收和正式实验分列；未完成接线不等于已可运行完整基准。

## 当前证据（2026-10-14）

| 层次 | 实际结果 | 边界 |
| --- | --- | --- |
| 103 个候选来源和结构审计 | 通过，零 LLM、零训练 | TabArena 全量解码和准备审计尚未执行 |
| 全指标差分 | DSBench 52 题普通/并列样本及边界共 105 例通过；TabArena 三指标官方函数对照通过 | 合成评分，不是全部任务训练 |
| 数据准备与隔离检查 | 43 个相关 Python 快速用例、4 个 TS 加载/评分用例通过 | 原生训练接线待完成 |
| DSBench 真实发布数据准备 | Titanic、Bike Sharing、s3e5、s3e13、s3e18、s4e3 六项通过 | 源哈希不变；没有拟合模型 |
| TabArena 真实准备 | 363612、363621、363685 三项通过 | ARFF/Parquet 合成解码均通过；APSFailure 真实准备待执行 |
| 官方 system 接口探针 | 固定可选环境安装与无训练探针通过 | Statigent 薄 wrapper 未验收 |
| 显式准备 CLI | Titanic、airfoil 新建及 Titanic 只读复用实际通过；3 个服务测试、6 个 CLI/原评测回归通过 | 源和准备哈希核对；独立回执保留本次及原始成本 |
| stage 4 隔离 runner | 23 个新旧 Python runner 用例及 6 个真实 Docker 拟合/独立加载预测用例通过 | 回归、二分类、有序类别、前三候选、双/七目标；尚未贯通原生搜索与交付 |
| 真实 LLM、正式研究实验 | 未运行 | 后续需要明确任务、方法、模型和预算 |

## 数据规模检查

命令：`bun run test:modeling:scale`。此次直接运行等价的
`uv run --no-sync pytest -s -m scale tests/python/test_modeling_data_scale.py`，退出 0。
机器本地报告为 `runs/modeling-benchmarks-validation/data-scale.json`（忽略 Git）。

每个分区 35,000 行；训练 36,458,901 bytes，延迟预测特征 36,353,899 bytes，
私有标签 35,513,896 bytes，预测 35,513,907 bytes，均超过旧 32 MiB 限制。
显式配置单文件 64 MiB、内存 1 GiB、1,000,000 行、4,096 列、单字段 65,536 bytes。
准备约 1.91 秒、加载约 0.90 秒、评分及限额拒绝检查约 1.00 秒，总计 3.81 秒；
进程峰值 RSS 318,537,728 bytes（约 304 MiB，含 Python 和评分依赖）。
预测逆序后按 ID 对齐，MAE 为 1；改回 32 MiB 限额时加载和评分明确拒绝。
这是有界合成数据链路检查，零拟合、零 LLM，不代表全部候选均符合相同额度。

新版准备、加载和评分共用 `python/statigent_modeling/data_limits.json` 的默认值与五个可配置维度。
TS 只传文件描述符；Python 流式准备和验证特征表。排名评分仍保留有界向量，
先检查文件及工作集估计，再计算；不能借助压缩文件绕过 Parquet 行组/批次内存检查。
历史数据和评分协议仍保持原有限额与数值规则。

`data` 可选依赖组通过 `uv sync --frozen --group data` 安装。
快速数据检查入口为 `bun run test:modeling:data`；默认快速测试不生成大文件，
没有安装该组时两个格式的测试明确跳过。规模与上游检查均须显式选择。
