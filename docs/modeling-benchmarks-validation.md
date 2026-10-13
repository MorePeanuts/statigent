# 建模基准接入验收记录

本记录随 `add-modeling-benchmarks` 实施更新。软件模块、真实数据准备、真实智能体验收和正式实验分列；未完成接线不等于已可运行完整基准。

## 当前证据（2026-10-14）

| 层次 | 实际结果 | 边界 |
| --- | --- | --- |
| 103 个候选来源和结构审计 | 通过，零 LLM、零训练 | TabArena 全量解码和准备审计尚未执行 |
| 全指标差分 | DSBench 52 题普通/并列样本及边界共 105 例通过；TabArena 三指标官方函数对照通过 | 合成评分，不是全部任务训练 |
| 数据准备与隔离检查 | 43 个相关 Python 快速用例、4 个 TS 加载/评分用例通过 | 原生训练另见后续行，统一批次待接入 |
| DSBench 真实发布数据准备 | Titanic、Bike Sharing、s3e5、s3e13、s3e18、s4e3 六项通过 | 源哈希不变；没有拟合模型 |
| TabArena 真实准备 | 363612、363621、363685 三项通过 | ARFF/Parquet 合成解码均通过；APSFailure 真实准备待执行 |
| 官方 system 接口探针 | 固定可选环境安装与无训练探针通过 | 薄 wrapper 的实际调用另列 |
| 官方 Statigent system | 固定官方类的回归/二分类/多分类实际 Docker 拟合、两次延迟预测、同预测评分对照及资源拒绝共 7 项通过（117.38 秒）；取消、定向清理及零新增 LLM/拟合断言通过 | 合成数据，零真实 LLM；真实 r0f0 待执行；独立运行根目录 `runs/tabarena-system-synthetic-verify-v1` |
| system 有界桥接及文档示例 | 5 个桥接快速用例、2 个 TS 协议用例通过；有界读取/截止时间更新后，官方二分类及资源拒绝 5 项补充回归通过（42.68 秒） | 文档 CLI 二分类示例通过，索引 `runs/tabarena-system-example/6ec0c891-3ac5-4112-865a-43575de74b10/system-verification.json`；零付费调用 |
| 显式准备 CLI | Titanic、airfoil 新建及 Titanic 只读复用实际通过；3 个服务测试、6 个 CLI/原评测回归通过 | 源和准备哈希核对；独立回执保留本次及原始成本 |
| stage 4 隔离 runner | 23 个新旧 Python runner 用例及 6 个真实 Docker 拟合/独立加载预测用例通过 | 回归、二分类、有序类别、前三候选、双/七目标；父级交付另见后续行 |
| 共用实验生命周期 | 新版等级、前三候选、七目标的搜索、诊断、两次确认及最终 fit-only 共 3 个 Docker 用例通过；同次 7 个旧实验回归通过（共 10 例，159 项断言） | 实际移走测试特征目录后仍完成内部阶段；零付费调用 |
| 宽表概览与 EDA 元信息 | 四方法真实 Docker 父循环通过（150 特征、双目标、30 项断言、135.50 秒），摘要完全相同；实际覆盖 explore/diagnose/compare 和 schema 5 检查 | 使用受控模型响应，零付费 API；并非真实智能体效果实验 |
| 冻结与延迟预测 | 原生 fit-only / fit→predict 两例、48 项断言通过（90.50 秒）；两次预测同一模型、坏输入、取消、超时及源哈希不变；预测 CLI 实际通过 | 无测试文件且开启两次确认的父级补充验收通过（26 项断言，65.39 秒）；零真实 LLM |
| 旧控制与交付兼容 | 49 个控制/确认/EDA 用例及 15 个交付、预检、概览、分类诊断与划分用例通过 | 完整 `bun run check` 和所有历史记录版本最终回归尚未执行 |
| 独立复现与外层评分 | 等级、前三候选、七目标三个 Docker 父运行均完成 predict/refit 和无模型目录重评（36 项断言、158.05 秒）；七目标记录篡改补充用例通过（14 项断言、54.62 秒） | 固定容差逐字段比较；Python 同分异预测、候选顺序及完整性检查通过；零真实 LLM |
| 历史只读审计 | 实际 schema 1–4 各一份记录 inspect 通过，递归源文件摘要前后相同；8 项评分/旧记录快速回归通过（46 项断言） | 索引 `runs/modeling-history-v1-v4-check.json`；最终全仓检查待执行 |
| 评测 v3 契约与旧分析兼容 | 36 项契约、文件限额、批次、记录、CLI、容器命令和旧重评测试通过（219 项断言）；9 MiB 预测按新限额通过、原报告上限仍拒绝 | 分阶段实际发布、原生建模适配及基准批次仍待接线 |
| 阶段输入发布与 Docker 隔离 | 初始 EDA、搜索、两次确认、最终拟合与延迟发布预测完整通过（23 项断言、58.81 秒）；测试特征提前访问、私有标签、仓库及宿主哨兵环境均不可见，来源哈希不变 | 21 个数据加载用例、18 个评测回归同时通过；运行索引 `runs/evaluation-modeling-isolation/7ec3745d-801a-496c-8869-754cd4d7e742`，零真实 LLM |
| 原生评测预算及重复种子 | 9 个适配/批次回归通过（82 项断言）；3 个 Python 派生划分检查通过 | 四方法共用父预算，子 EDA 不重复结算；未知用量停止后续派发，预留不足零模型调用；派生种子保持外层成员/特征/标签身份，记录独立准备开销；基准注册与交付冻结待完成 |
| 预测冻结与两基准注册 | 合成 DSBench/TabArena 批次真实 Docker 训练、预测、导出、inspect、定向清理和移走原生模型后的重评通过（28 项断言、69.12 秒）；26 个适配/CLI/记录/报告回归通过（177 项断言） | 两批次均无付费 API、未复用历史预测；实际 seed=42 派生自准备 seed=17。9 MiB 预测限额与 8 GiB 模型身份引用测试通过；篡改文件拒绝；真实数据与正式实验仍待后续验收 |
| 真实 LLM、正式研究实验 | 未运行 | 后续需要明确任务、方法、模型和预算 |

评分和比较补充验收：8 个报告/CLI 回归通过（72 项断言），包括最小化 MAE=1、RPG=1.125 与失败后的固定分母均值 0.5625，未运行或评分失败导致完整汇总为空、配对行不丢失；这些数值均为合成夹具。`uv run --no-sync pytest -q -m upstream tests/python/test_tabarena_metrics_upstream.py` 退出 0，4 项通过（6.65 秒）；三种冻结预测在固定官方环境实际调用评分，核对 r0f0、发布行序、原始类别/正类和误差映射，零模型/训练调用。软件配对导出不运行复现，不自动把其状态改成通过。

统一评测接入后的分析回归：`bun test tests/unit/evaluation-benchmark.test.ts tests/unit/evaluation-dsbench.test.ts tests/unit/evaluation-dacomp.test.ts tests/unit/evaluation-compat.test.ts tests/unit/evaluation-report.test.ts tests/unit/evaluation-cli.test.ts` 退出 0，20 例、135 项断言通过；包含三套分析协议、受控裁判、完整分母、v1 冻结交付重评及哈希保持。未调用真实 LLM。

## 数据规模检查

开发集合已在真实成绩产生前固定为 7 个 DSBench 与 3 个 TabArena 任务，覆盖回归、二/多分类、等级、前三候选、双/七目标，见 `benchmarks/metadata/modeling-development.json`。四方法使用相同来源、seed=17、一次重复、模型配置、镜像及确认/资源额度；全部 8 份真实方法配置（40 单元）和 2 份确定性配置（10 单元）只读 plan 通过，索引 `runs/modeling-development-preview-v1/index.json`。4 个新旧开发配置测试通过，71 项断言；未进行付费模型调用。

首轮全候选受限准备：`bun run evaluate audit-prepare --config configs/evaluations/modeling-preparation-audit.json --out runs/modeling-candidate-preparation-v1` 退出 0，103 项全部留有结果，耗时 307.838 秒，产物 1,149,801,794 bytes。83 通过、18 资源阻塞、2 失败；零训练、零 LLM。单文件 64 MiB、列数 4,096、工作集 1 GiB、单项 120 秒、批次 30 分钟、产物 4 GiB 并保留磁盘 4 GiB。`santander-value-prediction-challenge` 的失败经只读核查为 4,993 个唯一非空列超过上限；`363630` 的 ARFF 声明含未加引号缺失标记，解码器已修复为从名义类别集合排除 None、保留加引号 '?'，20 项准备回归通过。单项修复验证另行记录，首轮失败不覆写。

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
