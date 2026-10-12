# 统一评测

评测层通过独立的 BenchmarkAdapter 与 AgentAdapter 连接基准和智能体。注册发生在受信代码中；配置只选择注册 ID，不动态加载外部插件。公共任务包含目标、约束、明确输入清单和输出契约；私有标签只交给评分端。新批次使用契约版本 2，未知版本、字段及不支持的能力会被拒绝；版本 1 的旧批次仍可只读检查和重新评分（见下节）。

智能体只需返回终态、明确最终回答、交付文件和用量，无需使用 Notebook 或 Statigent 的角色/工具实现。模型配置复用 `configs/models.json`，用量区分模型返回的测量值、外部自报告、未知与不适用。缺失遥测不能记为零。

| 适配器 | 模型控制 | 执行种子 | 隔离 | 用量 |
| --- | --- | --- | --- | --- |
| statigent-eda | 现有 model profile | Python 执行，非模型采样保证 | Docker | 请求日志与模型返回用量 |
| container-command | 无模型，首版不联网 | 由协议提供 | Docker | 无模型调用时不适用 |

模型预算包含尝试次数、token 停止阈值；响应可能使 token 超出阈值，阈值不是账单硬上限。相同智能体可以注册多个配置分别比较。未实现的角色分离、脚本后端、预测文件及联网外部智能体不能通过配置冒充已支持。

## 契约版本

版本 2 相对版本 1 的变化：

| 对象 | v2 字段 | 说明 |
| --- | --- | --- |
| PublicTask | `output.kind` 为 `text` 或 `report` | 报告类型另含 `report_file`（必须是 `.md` 相对路径）、`image_types`（`png`/`jpeg`）、`max_images`、`max_image_bytes`、`max_report_bytes` |
| PublicTask | `inputs` 可以为空 | 用于没有数据文件的题目；v1 仍要求至少一个输入 |
| Capabilities | `outputs`（列表）、`trajectory`（`unified`/`none`） | 计划要求的输出类型不在 `outputs` 中时，预检拒绝 |
| Submission | `deliverables`、`trajectory` | 取代 v1 的 base64 `artifacts`；清单由评测层扫描冻结后填写，适配器返回空列表 |
| Score | `judge` | 评委用量与偏差标记；确定性协议为 null |
| 配置 / plan / manifest | `scoring`、`groups` | 评委映射与评分预算；分组汇总所需的任务分组 |

读取时 v1 对象在内存中转换为 v2 形状：文本输出不变，`artifacts` 映射为位于 `units/<unit_id>/artifacts/` 的交付并逐一校验哈希，Score 的 `judge` 为 null。磁盘上的 v1 文件不会被改写，计划哈希按原始内容校验。

报告任务的公开契约示例：

```json
{
  "schema_version": 2,
  "id": "dacomp-002",
  "version": "example",
  "goal": "Analyze the growth trend of Sales Amount for each Major Category.",
  "constraints": ["The database is read-only."],
  "inputs": [
    {
      "path": "dacomp-002.sqlite",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 1
    }
  ],
  "output": {
    "kind": "report",
    "instructions": "Write report.md in English and reference charts by relative path.",
    "report_file": "report.md",
    "image_types": ["png", "jpeg"],
    "max_images": 20,
    "max_image_bytes": 5242880,
    "max_report_bytes": 262144
  }
}
```

测试中的最小合成配置位于 `tests/fixtures/evaluation-config.json`，通过 `tests/helpers/evaluation.ts` 的合成注册表解析。它只验证契约和组合关系，不代表真实基准或真实隔离能力的实验结果。

## 文件记录与输入隔离

每个批次使用独立的 `runs/evaluations/<evaluation_id>/`，包含版本为 2 的评测 manifest、冻结计划、事件、units、scores 和 native 目录。这里的版本与原生执行记录版本独立。每个计划单元在调用智能体前就有记录；原生 EDA 运行只被关联，不修改它的清单和代码重放语义。一个合成命令批次的实际目录：

```text
<evaluation_id>/
  manifest.json  plan.json  events.jsonl
  native/unit-000001/                  # 原生运行（外部命令为空）
  units/unit-000001/
    input/data.csv                     # 发布的只读输入
    deliverables/result.txt            # 冻结后的交付文件（0444）
    record.json  submission.json
  scores/<score_id>/
    report.json  units.csv
    judge/<unit_id>.jsonl              # 仅评委协议产生
```

输入发布按路径、大小和 SHA-256 验证，只发布当前任务允许的普通文件，拒绝符号链接及越界。文件系统支持时使用写时复制克隆（APFS、Btrfs 等），否则退回普通复制；实际方式写入事件 `inputs_published`（`clone`/`copy`/`mixed`/`none`），两种方式都在发布前后校验哈希并设为只读。

交付目录在单元终止后由评测层扫描并冻结：只接受普通文件，拒绝符号链接、设备文件和超过 4 层的嵌套；单文件上限 8 MiB、总量 32 MiB、最多 64 个文件；逐个计算 SHA-256 后设为只读，清单写入 submission。目录不合规时整个目录改名为 `deliverables.rejected/` 留作审计，单元记为失败，并换成空的交付目录，按基准规则计分。报告类任务还会校验报告文件及其引用的图片（见契约版本一节）。评分前会重新比对文件集合与哈希，多出、缺少或被修改的文件都会让评分被拒绝。JSON 单文件上限 16 MiB、事件总量上限 16 MiB。原始数据只读，批次结果不提交 Git。

查看是只读操作。意外退出遗留的 running 状态显示为 unconfirmed，不推断成功，也不自动续跑。需要先检查记录并定向清理遗留资源；重新实验须创建新的批次身份。配置中的密钥值会被脱敏，仅保留环境变量名。

## InfiAgent 评分

适配来源固定为 InfiAgent commit `3d6c4a70198e0a41fadf539f5b43c88b8c1a2d9c`，56 项公开/私有数据及评分资源的 URL、大小与 SHA-256 保存在适配器来源清单，原始文件不修改。Python 比较函数保留上游提取与浮点语义，来源许可见 `third_party/infiagent/LICENSE`。

评分仅使用明确最终回答，Statigent 对应 `analysis.summary`；Notebook 和轨迹不用于补全缺失答案。ABQ 表示整题全对，PSAQ 是该题正确子答案的比例。主汇总每题每次重复等权，终止失败或空回答记零；未执行、状态未确认或评分基础设施错误使完整批次指标为 null，并标记 incomplete。

上游兼容结果仅包含非空有效回答，保留四位小数舍入，同时显示回答数和覆盖率。这一分母与主结果不同，不能替代完整任务成绩。默认测试用合成数据；`bun run test:evaluation:upstream` 显式使用已准备的本地上游脚本做差分校验，不下载数据。

当前固定数据中第 734 题存在重复参考答案键；按本变更的标签有效性约定，选择该题会明确预检失败。未选中任务的私有答案结构不影响所选任务。原始标签保持原样；若后续正式集合包含该题，需要显式修订评分协议，不能静默改变标签或排除规则。

## 智能体接入

`statigent-eda` 的 options 为 `{"image":"statigent-runtime:dev"}`，通过 model_profile 选择已有模型配置。适配器增加通用最终回答约束，原样提交 `analysis.summary`，完整 analysis 和 Notebook 保留在原生目录。用量来自原生清单与请求日志；未确认请求保留已知小计并标为未知。

`container-command` 的 options 包含 image 和 argv 数组，可设置 cpus、memory_bytes、pids、workspace_bytes，以及交付上限 max_file_bytes（默认 8 MiB）和 max_files_bytes（默认 32 MiB），二者不能超过评测层上限，并写入配置快照。镜像与命令是受信配置，任务不能覆盖它们。stdin 一条 JSON 请求（不含宿主路径，输入位于 `/input`），stdout 仅一条 JSON 响应；stderr 有界。响应使用命令协议 v1：形如 v1 Submission，`artifacts` 中的 base64 文件以相对路径命名，native_run 必须为空，首版用量必须为 not_applicable。宿主校验名称和大小后把文件解码写入该单元的交付目录，再由评测层冻结；stdout 上限随 max_files_bytes 换算，stderr 最大 1 MiB。不采用可写挂载输出目录，因为宿主无法限制 bind mount 的写入量。

构建测试镜像：`docker build -f docker/evaluation-fixture.Dockerfile -t statigent-evaluation-fixture:dev .`，前提是已有 `statigent-runtime:dev`。测试命令为 `uv run --offline --no-sync --frozen --project /opt/runtime python /opt/fixture.py`。容器无网络、无宿主环境透传和密钥，只读挂载当前输入。此测试智能体用于验证协议，不是可用于真实论文对比的分析方法。

非零退出、协议错误、超限均为失败；超时和取消清理实际容器，清理错误阻止后续派发。联网、宿主 shell、未实现角色/后端等配置被拒绝。模型提供商、模型名及思考参数只通过现有模型 profile 控制。

## 批次生命周期与预算

调度顺序为任务清单、智能体配置、重复序号；每个单元最多派发一次，使用独立输入与原生运行目录。模型内部重试计入真实尝试次数，评测器不会自动重跑失败题。普通任务失败在记录、清理和成本可靠时继续；用量未知且影响整批模型预算、记录错误或清理失败则停止。

当前配置的 cache_policy 为 disabled（省略时采用此值并写入有效配置），拒绝其他策略，不跨单元复用状态或产物。重新评分记录当时的评分代码 commit/dirty 与协议版本，不把原执行版本误记为新评分版本。

派发前取逐题额度与整批剩余额度的最小值，记录 effective_budget；预算缩减标为 reduced，不能当作完整预算公平对比。超额标为 exceeded，未知用量标为 unknown。批次时间包括发布、执行和评分，后续有界资源清理的耗时另行保留。

取消和整批超时传给当前适配器，后续任务标记 not_run 并保留原因。当前任务因超时终止且用量可靠时可以按基准规则计零；未运行任务不会被偷偷删除，完整得分保持为空。定向 cleanup 只处理本批次的容器和 native 目录对应运行，不自动重新执行。

## 报告与重新评分

每次报告写入新的 `scores/<score_id>/report.json` 和 `units.csv`。JSON 保存逐题评分细节、来源和分组汇总；CSV 每行对应一个计划单元，保留执行/评分/预算/用量状态。不同模型或智能体配置分别分组，不能把不同指标混成总分。CSV 对引号与换行转义，对可能被表格软件解释为公式的文本加前缀。

例：两题一题正确、一题终止失败，主 ABQ/PSAQ 均为 0.5；第二题未运行时，指标为 null、状态 incomplete；评分器异常时 scoring_status 为 failed，不能把它当作错误答案零分。用量未知时保留已知 token 小计和 unknown_attempts；账单成本为 not_computed，不推算价格。

离线 score 先检查冻结计划、交付和产物哈希及任务数据版本，再生成新的评分身份。旧评分、原始交付、执行费用和原生记录保持不变，整个过程不调用智能体或模型。初始评分和重评结果可直接并列核查。

## 命令与开发清单

在仓库根目录运行，依赖安装和基础镜像构建沿用 README。先完成无需 API 的完整示例：

```sh
docker build -f docker/evaluation-fixture.Dockerfile -t statigent-evaluation-fixture:dev .
bun run evaluate plan --config configs/evaluations/synthetic-command.json
bun run evaluate run --config configs/evaluations/synthetic-command.json
bun run evaluate inspect EVALUATION_ID
bun run evaluate score EVALUATION_ID
bun run evaluate cleanup EVALUATION_ID
```

`--root` 可指定评测结果根目录，默认 `runs/evaluations`；`--models` 指定模型配置文件，默认 `configs/models.json`。只有显式 `run` 会执行智能体。plan 会校验本地数据和所选标签，但不需要 API key、不启动容器。inspect 只读，score 不调用模型，cleanup 只清理指定批次资源。

固定开发清单为 `configs/evaluations/infiagent-development-selection.json`，依据公开难度、概念、题目/约束的依赖需求选择 12 题，各难度 4 题，每份 CSV 最多 2 题。排除需要额外统计检验或训练依赖的公开要求；选择器不读取答案。复现选择命令是 `bun src/evaluation/development.ts`，会重新生成三个开发配置文件，应审查 diff 后提交，不能根据得分换题。

真实冒烟固定为 0、5、308 三题，使用 DeepSeek `deepseek-flash`，每题 12 次调用、100,000 token、300 秒；整批 36 次调用、300,000 token、1,200 秒。密钥来自 `DEEPSEEK_API_KEY`。先预览后显式运行：

```sh
bun run evaluate plan --config configs/evaluations/infiagent-smoke.json
bun run evaluate run --config configs/evaluations/infiagent-smoke.json
```

12 题配置是 `infiagent-development.json`，不会自动运行。正式实验另行冻结配置，披露与开发题及共享 CSV 的重叠。迁移到 Linux 时使用同一锁文件、镜像构建与 CLI，调整基准根、模型环境变量和输出根；保留来源哈希，硬件与平台变化进入运行快照。

默认 `bun run check` 不启动 Docker 容器或调用付费模型。`bun run test:evaluation:integration` 显式验证测试镜像；`bun run test:evaluation:upstream` 显式验证本地上游资源。真实实验和软件测试结果分开记录。
