# EDA 规划者—执行者本地验收

变更：`add-eda-planner-executor`。工程链路、可控模型测试和真实 Docker 集成通过；单次真实模型任务完成报告，但未通过“跨委派数据状态复用”验收，因此任务 6.4 保持未完成。本记录不构成正式实验或双智能体收益证据。

## 代码与固定范围

实现位于 `feat/eda-planner-executor`。阶段提交覆盖共享模型调用、v3 角色记录、双角色路由、规划者报告、评测适配和协作集成。真实模型运行对应 `a766a55a76ff08049a2a21d587fe98cac052733c`，运行开始时工作区 clean。

命令：`bun run test:smoke:collaboration`。固定任务为 `configs/tasks/collaboration-report.json`，唯一输入 `tests/fixtures/synthetic.csv`（4 行，28 字节），SHA-256 为 `aeebac9f9230a60f964abc920acbfc66e52744783627b24c8cc35c804c350b7a`。目标为分组均值、最高均值组中心化偏差、样本量限制与带图报告。没有使用 Benchmark 题目或评分反馈。

预算为 20 次模型尝试、10 次执行、400,000 token 停止阈值、600 秒任务时限、90 秒单请求时限；代码修复、动作纠正、限流重试上限各 2。max_request_bytes=262144，max_response_bytes=2097152，max_trace_bytes=16777216。两角色共用 deepseek-flash profile，thinking=enabled，reasoning_effort=high，max_output_tokens=65536。角色提示词分别为 eda-planner-v1 / eda-executor-v1，哈希保存在原生清单。

宿主 Darwin 24.6.0 / arm64，Apple M1 Pro，8 逻辑 CPU、16 GiB 内存；Bun 1.4.2、Docker 29.4.0。容器 linux/arm64，镜像 ID `sha256:be16e287ff5e64098618358be8d8b528d3b0fe9171a39f5ef22b859019d45a1d`。容器 Python 3.12.9、ipykernel 6.30.1、jupyter_client 8.6.3、nbformat 5.10.4、numpy 2.3.3、pandas 2.3.2、matplotlib 3.10.6。未单独验收另一台 Linux 服务器。

## 自动验证

| 检查 | 实际结果 |
| --- | --- |
| `bun run check` | Biome、Ruff、TypeScript 通过；144 项 TypeScript、34 项 Python 快速测试通过 |
| `bun run test:integration` | 23 项 TypeScript Docker 集成、6 项 Python 真实内核测试通过 |
| `openspec validate add-eda-planner-executor --strict` | 通过 |
| 开发评测计划预览 | 单题 InfiAgent 配置可加载，展示双角色、同一 profile、12 次执行及统一模型预算；未运行付费评测 |

默认检查均使用可控响应或本地假 HTTP，不调用付费模型。双角色集成验证两次委派中真实复用 `df` / `means`、每个任务一个内核、不同任务没有遗留变量、活动执行取消清理、规划者报告交付和图片绑定、规划者消息不自动带入原代码/错误栈。错误修复保留完整错误轨迹，分析完成与严格重放 unsupported 分别报告。

完整集成中的正常双角色运行：`63590907-570d-4d1f-b647-1c70b6f2c9f0`、`38e5d3c5-c7e4-49f7-af80-3b1514046465`，位于 `runs/integration-collaboration/`。第一项在新容器中独立重放成功，源目录所有文件 SHA-256 不变；重放不产生规划者报告。上述运行是可控测试，不计作真实模型成功次数。

## 全部真实模型入口尝试

1. 首次启动在公共配置加载器拒绝缺少显式 `--model` 时退出，未创建原生运行、未发出模型请求。修复固定入口并加入回归测试后提交 `a766a55`；任务、profile、提示词和预算均未改变。
2. 唯一实际模型运行：`52babfb2-7440-41e4-86ba-c2cc893c4fcb`，2026-10-12 15:11:54–15:13:07 UTC。目录 `runs/collaboration-smoke/52babfb2-7440-41e4-86ba-c2cc893c4fcb/`。未因验收失败追加运行。

| 角色 | 请求次数 | 输入 token | 输出 token | 合计 token |
| --- | ---: | ---: | ---: | ---: |
| planner | 3 | 9,783 | 4,900 | 14,683 |
| executor | 8 | 52,581 | 9,641 | 62,222 |
| 总账 | 11 | 62,364 | 14,541 | 76,905 |

没有模型失败、限流重试、未知用量或动作校验纠正。总账已经包含两角色消费，不再叠加子任务小计；货币费用未计算。服务返回 deepseek-flash，指纹 `aeb56401ca74e127821c4f9126dcb669`，不等于可恢复的固定模型权重。任务墙钟约 73.48 秒，模型等待累计约 69.09 秒。

实际完成两次委派、6 个执行单元（5 个成功、1 个错误），一个持续内核。第一项委派为数据概况、分组统计与图表；执行者还提前完成了中心化偏差并写了一个工作区报告。第二项委派转向定量评估样本量限制，要求复用中间结果，但执行者尝试导入未安装的 scipy 后报错；随后没有安装依赖或重启内核，自行实现所需计算并完成返回。

规划者最后提交带一张 PNG 的 Markdown 报告，宿主保存为 `4647bd50-da6f-41c3-a4b8-d1d9160cdece`，明确 planner 来源；执行者先前写的 `report.md` 不是这份最终交付。最终报告及绑定图片已用适配器交付函数复制至 `runs/collaboration-deliveries/52babfb2-7440-41e4-86ba-c2cc893c4fcb/report.md`。

## 验收结论与未满足项

| 项目 | 结果 |
| --- | --- |
| 两次有效委派、执行者返回、规划者最终完成 | 通过 |
| 分组均值 A=2、B=4，最高均值组偏差 [-2, 2] | 通过，结构化结果与原始数据一致 |
| PNG 解码、Notebook 格式、有效证据引用、报告及图片交付 | 通过 |
| 同一内核、无重启、无残留容器 | 通过 |
| 跨委派数据变量复用 | **未通过** |
| 真实运行严格代码重放 | **unsupported: cell_error**，没有把修复后的分析完成伪装为可重放 |

验收器返回 `No cross-delegation data binding observed`，写入原目录 `smoke-result.json`，进程退出码为 1；原生任务终态仍是 completed。人工核对发现第二项委派重新读取 `synthetic.csv` 并重新绑定 `df`；读取 `group_stats.csv` 的尝试位于 scipy 导入失败之后，实际未执行。成功单元间只复用了导入模块等状态，不能视为前序分析数据复用。因此没有放宽验收器或改写 smoke-result 来宣称通过。

适中粒度目前仍是提示词约定：本次执行者提前做了后续分析和工作区报告，第二次委派又展开了较多小样本推断。核心协议允许这些行为，未加入语义粒度控制；它们是下一步改进委派边界与状态复用提示的直接证据。额外统计推断的正确性不在本次功能验收保证范围，不能将报告中的推断性陈述当作已验证研究结论。

当前保留任务 6.4 未勾选。后续若修改提示词或任务边界，应另行冻结版本和授权新的有界验收，保留本次失败记录；本次未自动追加尝试。第二章建模、正式基准与消融实验均未开展。
