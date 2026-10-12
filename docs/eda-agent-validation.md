# EDA 单智能体本地验收

本次验收对应 `add-eda-agent-loop`，不代表正式 Benchmark 或论文实验结果。运行产物保存在本机 Git 忽略的 `runs/`，这里只提交复验清单；请求密钥和完整运行轨迹不入 Git。

## 实现与平台

阶段提交：`04a5c46`（模型配置与 HTTP）、`b95b47f`（记录版本 2）、`7511292`（循环与预算）、`d20525d`（CLI 与完整验收入口）。真实模型运行对应 `d20525dbfdc8cfe214b69d8cd8ffd142a31ea63a`，工作区 clean。之后的审查修正只影响异常 HTTP 用量不完整时的重试判定，未增加真实模型调用；回归与快速检查重新通过。

宿主 macOS/Darwin 24.6.0、arm64、Apple M1 Pro、8 逻辑 CPU、16 GiB 内存；Bun 1.4.2、uv 0.8.22、Docker 29.4.0。容器 linux/arm64，镜像 ID：

`sha256:c6349da36ab17c7f5bb45cda16ff9d58fef957bbf41cfed0655cbd2595939a5e`

容器 Python 3.12.9、ipykernel 6.30.1、jupyter_client 8.6.3、nbformat 5.10.4、numpy 2.3.3、pandas 2.3.2、matplotlib 3.10.6。尚未在另一台 Linux 服务器单独验收。

## 自动检查与可控集成

| 检查 | 实际结果 |
| --- | --- |
| `bun run check` | Biome/Ruff/typecheck 通过，53 项 TypeScript 快速测试、11 项 Python 快速测试通过 |
| `bun run test:integration` | 18 项 TypeScript Docker 集成、5 项 Python 真实内核测试通过 |
| `openspec validate add-eda-agent-loop --strict` | 通过 |
| Git 范围与秘密审计 | diff 无空白错误，跟踪文件中无真实环境密钥、运行产物或环境目录 |

常规测试仅调用回环假 HTTP 或注入脚本模型，未发起付费请求、未下载 Benchmark。集成包含旧 runtime 回归、版本 1/2 记录、跨单元状态、非法混合动作拒绝、错误后的部分状态及修复、预览截断、预算终止、代码取消、假密钥/文件隔离、PNG/报告引用、CLI 成功/失败退出码与清理。

可控模型全量集成运行（`runs/integration-agent/`）：

- 正常分析：`236051c1-0060-437e-9ded-614926c0b664`；独立代码重放：`d53df5bb-7b11-40de-8457-cf027e034ad7`。
- 非法动作纠正与错误修复：`56f16a9f-5a9d-4cad-b8f7-fe447928ab1d`，分析完成，保留原错误，严格重放为 unsupported。
- 执行预算耗尽：`a571acae-db98-4372-b07e-8074a78b1644`，明确未完成。

上述运行是可控验证，不计作真实 DeepSeek 成功次数。

## 真实 DeepSeek 单次冒烟

命令：

```sh
bun run test:smoke:model -- --model deepseek-flash --task configs/tasks/synthetic-eda.json
```

运行：`fcefd6a2-b142-431a-a29f-2b3ccc199ba0`，目录 `runs/agent/fcefd6a2-b142-431a-a29f-2b3ccc199ba0/`。一次合成任务，首次即通过，未重跑；3 次 HTTP 模型尝试，0 次失败/限流重试、0 次未知用量。

请求和服务返回模型均为 `deepseek-flash`；展示名 DeepSeek-V4.1-Flash；服务指纹 `aeb56401ca74e127821c4f9126dcb669`。别名和指纹不等于可恢复的固定模型权重。

有效参数为 thinking=enabled、reasoning_effort=high、max_tokens=4096。预算：12 次模型尝试、8 个实际执行单元、累计 token 阈值 100000、单请求 90000 ms、任务 300000 ms、限流重试 2、代码修复 2、动作纠正 2、请求 262144 字节、响应 2097152 字节、模型轨迹累计 16777216 字节。

实际输入 4695 tokens、输出 1448 tokens，合计 **6143 tokens**；缓存/推理子项保留在各次事件中，未重复相加。API 等待累计约 7893 ms，任务墙钟约 12455 ms。货币费用未计算，不能写成零费用。以上是本次全部真实模型验证用量。

模型自主生成两个成功单元：首个读取 4 行 CSV、检查类型/缺失并保留 `df`；第二个复用 `df`，计算并打印 `group_means: {'A': 2.0, 'B': 4.0}`，保存 `group_means.png`（18046 字节）。宿主检查结构化结论中的均值与当前运行证据，Pillow 验证 PNG 可解析，nbformat 验证 Notebook，Docker 标签检查无残留容器。人工二次核对实际代码和执行输出，与结构化结论一致，没有入口预写分析代码或向模型提供参考均值。

产物包括 analysis.json、analysis.md、manifest.json、events.jsonl、有界模型/执行产物、Notebook 和 smoke-result.json。

## 独立代码重放

真实轨迹重放：`91d53635-0145-466c-ae12-c932fca41271`，位于 `runs/replays/`。新容器中执行两个原始代码单元，结果 passed；源运行全部 **18 个文件 SHA-256 不变**。新清单 run_kind=code_replay，model/tokens=not_applicable，未调用模型；源与重放容器均无残留。核对结果保存在重放目录 source-verification.json。

```sh
bun run runtime inspect runs/agent/fcefd6a2-b142-431a-a29f-2b3ccc199ba0
bun run runtime replay runs/agent/fcefd6a2-b142-431a-a29f-2b3ccc199ba0 runs/replays
```

代码重放不重演模型决策；含原始错误的已修复轨迹仍不支持严格代码重放。模型首版只看文本和图表引用，不能声称看过图像。token 是结算后的停止阈值，未知消费立即停止；引用校验只证明可追溯，不自动验证结论语义。后续仍需小规模 Benchmark 开发、规划/执行分离与多模型正式实验。
