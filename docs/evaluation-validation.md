# 统一评测层验收记录

日期：2026-10-12。变更：`add-evaluation-harness`。这是软件接入与固定开发集合的验收，不是正式全量实验或论文方法复现。

## 自动检查

| 检查 | 实际结果 |
| --- | --- |
| `bun run check` | Biome、Ruff、TypeScript 通过；78 项 TypeScript 测试、18 项 Python 快速测试通过 |
| `bun run test:integration` | 19 项 TypeScript Docker 集成测试、5 项真实 Python 内核测试通过 |
| `bun run test:evaluation:upstream` | 1 项本地上游差分测试通过 |
| `openspec validate add-evaluation-harness --strict` | 通过 |

快速检查不调用付费模型；集成验证使用可控模型响应和真实容器。测试覆盖两个基准/两个智能体的注册组合、固定计划、文件隔离、错误/取消/超时、预算与未知用量、原生记录兼容、评分分母、JSON/CSV 和离线重评。

完整集成回归之后，磁盘记录校验、原生 staging 清理及字段顺序重评问题又经过针对性回归和实际批次复核；最终快速检查在 `904dc31` 上通过。

## 无模型端到端示例

配置：`configs/evaluations/synthetic-command.json`。批次：`4af20a46-2cbc-49e8-a77e-5e858b159566`。

离线 Python 命令在 Docker 中读取合成 CSV，返回最终回答和文本产物，无 Notebook、无模型调用。plan、run、inspect、score、cleanup 文档命令均实际运行成功。该结果只用于接入验收。

## DeepSeek 固定三题冒烟

- 配置：`configs/evaluations/infiagent-smoke.json`；选择依据及输入哈希见同目录 `infiagent-development-selection.json`。
- 开发清单提交：`da2d113`，在真实模型调用前冻结；未按成绩调整任务。
- 执行源码：`872072f51a6d1e4e2114652061f8295aae5e8f41`，工作区干净。
- 模型配置：`deepseek-flash`；请求名 `deepseek-flash`，展示名 `DeepSeek-V4.1-Flash`；单智能体、持久内核、种子 42。
- 批次身份：`ff53e5a2-2b11-4c11-b260-99a07bec14c8`。
- 原始评分身份：`ad91d303-9caa-43c6-b5df-c54dc1255785`。
- UTC 时间：07:50:47.169–07:51:14.639。
- 预算：每题 12 次模型尝试、100,000 token 停止阈值、300 秒；整批 36 次、300,000 token、1,200 秒。只运行一次，没有追加模型尝试或重跑题目。

| 任务 ID | 难度 | 执行/评分 | ABQ | PSAQ | 模型请求数 | Tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | easy | completed / scored | 1 | 1 | 3 | 5,417 |
| 5 | medium | completed / scored | 1 | 1 | 3 | 5,230 |
| 308 | hard | completed / scored | 1 | 1 | 3 | 6,102 |

汇总：3/3 题交付并评分，ABQ=1、PSAQ=1；9 次模型请求，输入 14,597、输出 2,152、总计 16,749 tokens，未知请求数为 0。逐单元执行耗时合计 27,303 ms，确定性评分合计 110 ms。货币费用未计算；没有把这些 token 换算成未核实价格。

环境：macOS/Darwin 24.6.0、Apple M1 Pro（8 核、16 GiB）、Bun 1.4.2、uv 0.8.22、Python 3.12.9、Docker 29.4.0。执行平台为 Linux/arm64，镜像 ID 为 `sha256:c6349da36ab17c7f5bb45cda16ff9d58fef957bbf41cfed0655cbd2595939a5e`。完整脱敏配置、来源校验值、锁文件哈希和原生运行引用在批次清单中。

## 二次验收与修复

真实执行后的命令复核发现两个兼容问题：定向清理误把原生 `.staging` 当成 run_id；离线重评把对象字段顺序误判成数据变更。已在 `904dc31c993ebff33db2655c9d0a48297f83fc4d` 修复，并分别加入回归覆盖。两处修复不改变智能体执行和答案计分规则，未重跑付费任务。

修复后的 cleanup 成功；按批次及三个原生 run_id 查询，均无遗留容器。最终离线重评在干净的 `904dc31` 上执行，score_id 为 `d8e97ef3-4b0e-458a-a1f3-8c2b15c0df33`，ABQ/PSAQ 与原评分一致。原评分及交付仍保留，重评没有模型请求。

完整运行产物位于 Git 忽略的 `runs/evaluations/<evaluation_id>/`，本记录只提交复现身份与汇总，不提交真实数据、标准答案、密钥或完整轨迹。

## 当前边界

首版为本地串行、文本答案评测。联网外部论文智能体、DAComp/DSBench 适配、预测文件、LLM 评委、并行实验及正式多模型比较尚未实现。容器命令测试智能体仅证明协议与隔离可用。

三题成绩只说明该开发样本的实际结果，不代表整个 InfiAgent 集合或研究收益。正式实验需独立冻结任务、重复次数和预算，并披露与开发题及共享 CSV 的关系。固定上游第 734 题的重复答案键会明确预检失败，未改写上游标签。
