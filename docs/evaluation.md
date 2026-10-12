# 统一评测

评测层通过独立的 BenchmarkAdapter 与 AgentAdapter 连接基准和智能体。注册发生在受信代码中；配置只选择注册 ID，不动态加载外部插件。公共任务包含目标、约束、明确输入清单和输出契约；私有标签只交给评分端。当前契约版本为 1，未知版本、字段及不支持的能力会被拒绝。

智能体只需返回终态、明确最终回答、产物和用量，无需使用 Notebook 或 Statigent 的角色/工具实现。模型配置复用 `configs/models.json`，用量区分模型返回的测量值、外部自报告、未知与不适用。缺失遥测不能记为零。

| 适配器 | 模型控制 | 执行种子 | 隔离 | 用量 |
| --- | --- | --- | --- | --- |
| statigent-eda | 现有 model profile | Python 执行，非模型采样保证 | Docker | 请求日志与模型返回用量 |
| container-command | 无模型，首版不联网 | 由协议提供 | Docker | 无模型调用时不适用 |

模型预算包含尝试次数、token 停止阈值；响应可能使 token 超出阈值，阈值不是账单硬上限。相同智能体可以注册多个配置分别比较。未实现的角色分离、脚本后端、预测文件及联网外部智能体不能通过配置冒充已支持。

测试中的最小合成配置位于 `tests/fixtures/evaluation-config.json`，通过 `tests/helpers/evaluation.ts` 的合成注册表解析。它只验证契约和组合关系，不代表真实基准或真实隔离能力的实验结果。

## 文件记录与输入隔离

每个批次使用独立的 `runs/evaluations/<evaluation_id>/`，包含版本为 1 的评测 manifest、冻结计划、事件、units、scores 和 native 目录。这里的版本与原生执行记录版本独立。每个计划单元在调用智能体前就有记录；原生 EDA 运行只被关联，不修改它的清单和代码重放语义。

输入发布按路径、大小和 SHA-256 验证，只复制当前任务允许的普通文件，拒绝符号链接及越界。交付以排他写入冻结，小型产物单独保存并校验哈希；JSON 单文件上限 16 MiB、事件总量上限 16 MiB，协议产物另有更小限制。原始数据只读，批次结果不提交 Git。

查看是只读操作。意外退出遗留的 running 状态显示为 unconfirmed，不推断成功，也不自动续跑。需要先检查记录并定向清理遗留资源；重新实验须创建新的批次身份。配置中的密钥值会被脱敏，仅保留环境变量名。

## InfiAgent 评分

适配来源固定为 InfiAgent commit `3d6c4a70198e0a41fadf539f5b43c88b8c1a2d9c`，56 项公开/私有数据及评分资源的 URL、大小与 SHA-256 保存在适配器来源清单，原始文件不修改。Python 比较函数保留上游提取与浮点语义，来源许可见 `third_party/infiagent/LICENSE`。

评分仅使用明确最终回答，Statigent 对应 `analysis.summary`；Notebook 和轨迹不用于补全缺失答案。ABQ 表示整题全对，PSAQ 是该题正确子答案的比例。主汇总每题每次重复等权，终止失败或空回答记零；未执行、状态未确认或评分基础设施错误使完整批次指标为 null，并标记 incomplete。

上游兼容结果仅包含非空有效回答，保留四位小数舍入，同时显示回答数和覆盖率。这一分母与主结果不同，不能替代完整任务成绩。默认测试用合成数据；`bun run test:evaluation:upstream` 显式使用已准备的本地上游脚本做差分校验，不下载数据。

当前固定数据中第 734 题存在重复参考答案键；按本变更的标签有效性约定，选择该题会明确预检失败。未选中任务的私有答案结构不影响所选任务。原始标签保持原样；若后续正式集合包含该题，需要显式修订评分协议，不能静默改变标签或排除规则。

## 智能体接入

`statigent-eda` 的 options 为 `{"image":"statigent-runtime:dev"}`，通过 model_profile 选择已有模型配置。适配器增加通用最终回答约束，原样提交 `analysis.summary`，完整 analysis 和 Notebook 保留在原生目录。用量来自原生清单与请求日志；未确认请求保留已知小计并标为未知。

`container-command` 的 options 包含 image 和 argv 数组，可设置 cpus、memory_bytes、pids、workspace_bytes。镜像与命令是受信配置，任务不能覆盖它们。stdin 一条 JSON 请求，stdout 仅一条 JSON 响应；stderr 有界。响应使用通用 Submission，native_run 必须为空，首版用量必须为 not_applicable。产物以 base64 交付，单项最大 1 MiB、总量 4 MiB；stdout 最大 8 MiB、stderr 最大 1 MiB。

构建测试镜像：`docker build -f docker/evaluation-fixture.Dockerfile -t statigent-evaluation-fixture:dev .`，前提是已有 `statigent-runtime:dev`。测试命令为 `uv run --offline --no-sync --frozen --project /opt/runtime python /opt/fixture.py`。容器无网络、无宿主环境透传和密钥，只读挂载当前输入。此测试智能体用于验证协议，不是可用于真实论文对比的分析方法。

非零退出、协议错误、超限均为失败；超时和取消清理实际容器，清理错误阻止后续派发。联网、宿主 shell、未实现角色/后端等配置被拒绝。模型提供商、模型名及思考参数只通过现有模型 profile 控制。

## 批次生命周期与预算

调度顺序为任务清单、智能体配置、重复序号；每个单元最多派发一次，使用独立输入与原生运行目录。模型内部重试计入真实尝试次数，评测器不会自动重跑失败题。普通任务失败在记录、清理和成本可靠时继续；用量未知且影响整批模型预算、记录错误或清理失败则停止。

派发前取逐题额度与整批剩余额度的最小值，记录 effective_budget；预算缩减标为 reduced，不能当作完整预算公平对比。超额标为 exceeded，未知用量标为 unknown。批次时间包括发布、执行和评分，后续有界资源清理的耗时另行保留。

取消和整批超时传给当前适配器，后续任务标记 not_run 并保留原因。当前任务因超时终止且用量可靠时可以按基准规则计零；未运行任务不会被偷偷删除，完整得分保持为空。定向 cleanup 只处理本批次的容器和 native 目录对应运行，不自动重新执行。
